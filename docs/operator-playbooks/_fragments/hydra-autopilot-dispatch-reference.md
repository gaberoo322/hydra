# hydra-autopilot — Dispatch reference

Class-by-class dispatch detail that the always-loaded SKILL.md points to:
what each class dispatches, the protocols a few classes carry in their
dispatch prompt, and why the dispatch preambles are worded as they are. Read
the section a pointer names — not the whole file. The authoritative source
for dispatch policy is `scripts/autopilot/decide.py`.

## Class taxonomy (7 pipeline slots + 15 signal classes)

| Kind | Class | Skill |
|---|---|---|
| pipeline | `dev_orch` | hydra-dev (**implement** stage — composed on the vendored upstream `implement` base, ADR-0030 Decision 2 / #3422) |
| pipeline | `qa_orch` | hydra-qa (**review** stage — composed on the vendored upstream `code-review` base, ADR-0030 Decision 2 / #3420) |
| pipeline | `research_orch` | hydra-research / hydra-issue-research |
| pipeline | `dev_target` | hydra-target-build |
| pipeline | `qa_target` | hydra-target-qa (issue #4576 — the purpose-built Target QA skill, dispatched with a pre-resolved PR ref; `hydra-qa` has no target-scope path) |
| pipeline | `research_target` | hydra-target-research |
| pipeline | `design_concept_orch` | hydra-grill (Phase B, warn-only — the **spec** stage of the one-lineage refit; ADR-0030 Decision 2, superseded for this stage's base by ADR-0035) |
| signal | `health` | hydra-doctor (scope-agnostic) |
| signal | `sweep_orch` | hydra-sweep |
| signal | `sweep_target` | hydra-target-sweep |
| signal | `discover_orch` | hydra-discover |
| signal | `discover_target` | hydra-target-discover |
| signal | `scout_orch` | hydra-tool-scout (Phase B, weekly calendar walk) |
| signal | `architecture_orch` | hydra-architecture-scan (#788; idle-time fallback, issue-producing) |
| signal | `retro_orch` | hydra-retro (#919; daily per-run retrospective, issue-producing + ≤1 gated PR) |
| signal | `cleanup_orch` | hydra-cleanup (#960; board-idle deterministic dead-code/simplification scan, issue-producing → `ready-for-agent`) |
| signal | `cleanup_target` | hydra-target-cleanup (Target mirror of cleanup_orch; demote-only dead-export sweep over ~/hydra-betting, backlog-item-producing → `ready-for-agent` + `queued`) |
| signal | `wire_or_retire_target` | hydra-wire-or-retire (#2722, epic #2720; judgment counterpart to cleanup_target — resolves triage `wire-or-retire` items into WIRE/RETIRE/UNCLEAR verdicts; 24h cooldown, ≤2 items/run, model param omitted) |
| signal | `design_qa_target` | hydra-design-qa (#2739, parent #2732; periodic VISUAL QA — screenshots every nav-registry route + judges vs the Target design ADR's [judgment] rules, files ≤3 deduped `needs-triage` design-qa items/run; 7d calendar cooldown, >5-open saturation backstop, model param omitted) |
| signal | `skill_prune` | hydra-skill-prune (#2949, epic #2944; eval-gated PROMPT counterpart to cleanup_orch — prunes ONE playbook-generated skill/run along the Pocock taxonomy [duplication/sediment/no-op], gated on promptfoo golden-task parity, ≤1 T1/T2 PR/run editing only that playbook + its regenerated skill + tightened ratchet baseline, else files a `needs-triage` candidate list; 7d calendar cooldown, saturation backstop, `apply:true`, model param omitted) |
| signal | `wayfinder_orch` | **ticket-type routed** (#3351, epic #3350, ADR-0029; the single AFK working class for wayfinder maps — works the next unblocked, unclaimed AFK-typed frontier ticket on an open approved `wayfinder:map`. The `skill` is resolved at dispatch time from `prompt_args.ticket_type`: `research` → hydra-issue-research, `task` → hydra-dev. 1h cooldown, one ticket/fire, model param omitted; collect-state.sh owns the native GraphQL frontier enumeration, decide.py stays pure) |
| signal | `tickets_orch` | hydra-tickets (#3423, epic #3419, ADR-0030 Decision 2/5; the **tickets**-STAGE producer — turns a resolved plan into one parent epic + N tracer-bullet child issues. Dispatches the COMPOSED `hydra-tickets` skill (vendored `to-tickets` base + AFK overlay, #3992), never the bare upstream `to-tickets` (disable-model-invocation hard-errors) nor the demoted `hydra-prd` renderer. Fires on the `tickets_available` signal collect-state.sh emits from the oldest unassigned `needs-tickets` spec (#4014) — structural twin of `wayfinder_orch` (1h, plan-anchored, signal class, not pipeline), so likewise deliberately NOT seeded into bootstrap's carry-forward `signal_last_fired`. 1h cooldown, one spec/fire, model param omitted; collect-state.sh owns the GH enumeration + ref pre-resolution, decide.py stays pure) |

> **One-lineage stage bindings (ADR-0030 Decision 2; ADR-0035 supersedes the spec-stage base).** The three code-writing pipeline stages compose against the *same* vendored upstream Pocock skills the operator runs interactively (lineage home `docs/operator-playbooks/_vendor/`, ADR-0030 Decision 4 / Option C): the **implement** stage (`dev_orch` → `hydra-dev`) rides `_vendor/implement.md`, the **review** stage (`qa_orch` → `hydra-qa`) rides `_vendor/code-review.md`, and the **spec** stage (`design_concept_orch` → `hydra-grill`) composes on NO upstream base. The `decide.py` `make_dispatch` string literals (`hydra-dev` / `hydra-qa` / `hydra-grill`) **stay live and unchanged** — they are the class rows that *select* these composed stages, not a second inline copy of the pattern. The grill-before-build sequencing (the #628 gate; post-#3711 `dev_orch` yields **per-anchor** rather than board-wide — see the Signal wiring table) is a documentation/lineage rebind here, **not** a change to that `decide.py` gate.

## Model routing rationale

The routing table itself (class → model) stays in SKILL.md § Per-class model
routing. This is the reasoning behind it.

Right-sized by **stakes × frequency** — drop the high-frequency non-authoring
classes off the frontier model; keep behaviour-reshaping and money-critical
authoring classes on Fable 5 (the frontier model, replacing Opus as of
2026-06-10) **when Fable is actually entitled**. Entitlement returned
2026-08-19 and was re-verified 2026-09-02 with the prescribed
`Agent(model="fable")` smoke test (`FABLE-OK: claude-fable-5`), so the map
routes the behaviour-reshaping and money-critical classes back to Fable.

**`dev_orch` demoted to Sonnet 2026-07-29 — on evidence, not a cost guess.** The
GLM dev-drainer beachhead (ADR-0032) authored 9 CI-green PRs here on GLM-5.2, a
model *below* Sonnet on SWE-bench. A sub-Sonnet model clearing this repo's
`dev_orch` bar is direct evidence Sonnet clears it. `dev_target` does NOT inherit
this: the beachhead is fenced off the Target board, so money-critical authoring
was never measured. Frontier is retained where the evidence does not reach.

| Class (`slot`) | Rationale |
|---|---|
| `dev_orch` | Multi-file, tier-gated self-modification — but measured (above). An `ESCALATION_POLICY` row re-dispatches a `subagent_failure` once at frontier, so a capability miss self-rescues. `qa_orch` + CI unchanged. |
| `dev_target` | Money-critical authoring. The 2026-08-04 Sonnet trial ended unmeasured (Target mothballed before a verdict); the successor target launches at the frontier tier and demotes on evidence, not the reverse. |
| `retro_orch` | Reshapes future behaviour; per-run low volume. The 2026-08-04 demotion was cost-emergency-driven and prescribed its own reversal on entitlement + smoke test (both done). |
| `design_concept_orch` | A weak design concept wastes a full dev+QA cycle downstream; low volume — same re-promotion basis as `retro_orch`. |
| `qa_orch` | Highest ROI; structured review against an artifact, ~every PR |
| `qa_target` | Money-critical review — the last judgment before auto-merge on real-money code. Sonnet remains the hard floor if cost ever forces a demotion. |
| `sweep_orch` / `sweep_target` | Board-routing decisions, not authorship |
| `health` | Structured diagnosis; rare small fixes |
| `research_orch` | Bounded codebase+web enrichment, not design |
| `research_target` | Strategic; trial, watch priority quality, revert on drift |
| `architecture_orch` | Non-interactive Explore+emit wrapper |
| `scout_orch` | Search + rubric scoring (low frequency, modest ROI) |
| `cleanup_orch` | Deterministic knip output; LLM only formats findings into issues |
| `cleanup_target` | Deterministic knip output + tested emit runner; LLM only drives the two commands |
| `wire_or_retire_target` | Judgment work — recover a module's intent (git archaeology + vision/priorities/backlog cross-ref) and decide WIRE/RETIRE/UNCLEAR. NOT deterministic like `cleanup_target`; a low tier hits the documented Haiku-premature-exit failure mode (narrates "standing by", files nothing). Omit `model` so it inherits the parent (Fable 5), per #1093. |
| `design_qa_target` | Visual judgment work — grade every route's screenshot against the Target design ADR's [judgment] rules (consistency / density / empty-state honesty). Like `wire_or_retire_target` it is an opinion, not a deterministic check; omit `model` so it inherits the parent (Fable 5), per #1093, to avoid the Haiku-premature-exit failure mode. |
| `discover_orch` / `discover_target` | Patrol/diagnostics, designed small/fast/cheap |
| `wayfinder_orch` | Works a wayfinder-map frontier ticket (research enrichment or a `wayfinder:task` build) — real authoring/judgment on a foggy initiative, not a deterministic check. Omit `model` so it inherits the parent (Fable 5), per #1093, avoiding the Haiku-premature-exit failure mode. |

## Cascade-routing escalation

SKILL.md § Per-class model routing carries the three mandatory steps and the
deposit command. This is the reasoning behind them.

**Cascade-routing escalation override (issue #3274).** When a `dispatch` action
carries `prompt_args.escalate_model` (a string model alias, e.g. `sonnet`), that
value **overrides** the static per-class model resolved from the map above for
that ONE dispatch — pass `model=action.prompt_args.escalate_model` to the `Agent`
call instead of the class's default. This is the cascade-routing lever: `decide.py`
re-dispatches a cheap-tier class (today `cleanup_orch` at Haiku) that just
`no_op`'d / `failed` at a stronger tier, but stays PURE — it emits only the
`escalate_model` HINT (never a concrete `model` field; the model lever stays here
in the playbook per #1093). The escalation action also carries
`prompt_args.attempt` (the escalated attempt number) — **stamp it onto the new
slot (`slot["attempt"] = action.prompt_args.attempt`)** so a subsequent `no_op`
of the escalation attempt reads `attempt >= max_attempts` in `decide_escalation`
and never triggers a THIRD dispatch (the `ESCALATION_POLICY` max-attempts cap,
default 2). `prompt_args.prior_attempt_status` records what triggered the
escalation, for turn-journal visibility. A dispatch with no `escalate_model` key
uses the static routing map unchanged (zero behavior change for non-escalated
work). The escalation policy + reducer live in `scripts/autopilot/decide.py`
(`ESCALATION_POLICY`, `decide_escalation`); a class absent from that dict never
escalates.

**MANDATORY — deposit the escalation provenance (issue #3284).** The moment you
execute a `dispatch` action carrying `prompt_args.escalate_model`, deposit the
cascade-routing provenance so `scripts/autopilot/reap.py`'s
`_read_escalation_deposit` can read it back and forward it on the single
cycle-record write — otherwise `escalationAttempt` / `escalatedModel` land
permanently null on the durable per-dispatch outcome record and
`/metrics/cascade-routing` reports a structural 0 cost-delta + 0
postEscalationMergeRate forever. This is the WRITE half of the read path reap.py
already implements. Unlike the reflection/grounding deposits (written by the
worktree subagent from its own `agent-<HASH>` cwd), the escalation provenance is
known ONLY to you (the harness) at dispatch time, so pass the escalated
dispatch's **task_id explicitly** — the slot `task_id` you just allocated (the
`worktree-agent-<HASH>` suffix `reap.py` keys the completion on). Run this
BEFORE (or right alongside) the `Agent(...)` dispatch:

The helper writes `hydra-escalation-<task_id>` only when the provenance is
well-formed (a positive `attempt` and non-empty model), so a malformed
invocation can never fabricate a bogus escalation marker. A non-escalated
dispatch never runs this — no deposit → reap omits the fields (truthful null,
the overwhelming majority).

## dev_orch resume internals

How a `dev_orch` anchor that ended without a PR is caught, queued and
re-dispatched. The dispatch-time rules (name the pinned issue, say it is a
resume, carry the forward-fix contract) stay in SKILL.md § `dev_orch`
dispatch.

**Reap-side backstop (issue #3866).** `scripts/autopilot/reap.py`'s
`_handle_dev_orch_stall` (called from every `dev_orch` completion reap) checks
whether an open PR references the completion's anchor, via the same
`pr-refs.py` predicate `recover-stale.sh` uses (issue #3852). No open PR found
→ the source issue is relabelled away from `ready-for-agent`/`in-progress` to
`needs-dev-resume` (a label pre-created for this issue), an explanatory
comment is posted, and a resume record is queued onto
`state.dev_resume_pending` for the drain above. This is the backstop for the
forbidden-ending rule (see the Worktree-guard preamble section) — it exists to
limit the blast radius of a dispatch that ends without a PR, not to make
ending early acceptable. The check fails OPEN (no mutation) on any `gh`
hiccup, so a transient network blip never mislabels a healthy in-flight
anchor.

**Durable dev resume (issue #4518).** `/tmp/hydra-autopilot-state.json` is a
cache, so the resume path no longer depends on it surviving. Three mechanisms:

1. **The kill itself.** `scripts/systemd/hydra-autopilot.service` sets
   `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=3600000`. Print mode waits at most
   that long for background tasks after the parent's handoff turn (#1903),
   then terminates the process and every in-process background child with it.
   At the harness default (600000) no code-writing child reached its commit
   step — six consecutive `dev_orch` dispatches at #4510 died uncommitted.
   The value is COUPLED to `decide.py`'s silent-wedge cap
   (`subagent_max_wall_seconds`, default 3600s): change one, change both.
   Never `0` — a wedged child would pin the unit to `RuntimeMaxSec` and
   `bootstrap.sh`'s live-pid guard would refuse every Pace Gate launch.
2. **The queue survives a relaunch.** `bootstrap.sh` carries the prior state
   file's `dev_resume_pending` forward (dedup by anchor, FIFO cap 20; a
   missing/unparseable prior file seeds `[]`).
3. **The label + PR ledger are the source of truth.** `collect-state.sh` emits
   `orch_dev_resume_pick=issue-N:P:B` for the lowest-numbered open, non-draft,
   non-GLM PR whose single closing issue carries `needs-dev-resume` (same
   quiescence / no-pending-required rails as the GLM pick; fails closed to
   `none`). The `dev_orch` selector pins it AFTER the in-state drain above and
   BEFORE the #4460 GLM pin, regardless of `orch_work_available`, of whether
   `dev_resume_pending` holds a record, or of which run queued it. The action
   carries `prompt_args.forward_fix_pr`, so the forward-fix dispatch contract
   below applies verbatim (continue the PR's head, push to the SAME branch,
   NEVER `gh pr create`) — minus the `glm-authored` clause and the attempt
   cap, which stay #4460-only. Reap's needs-qa promotion clears the label.

On the disk side, `scripts/branch-prune.sh` — the only deleter of
`.claude/worktrees/agent-*` — never removes a worktree holding uncommitted
work without first committing it on the worktree's own `worktree-agent-<hash>`
branch and pushing that branch to origin; a failed push leaves the worktree in
place (`skip-dirty-unpushed`). A resume's `git ls-remote origin <resume_branch>`
therefore finds salvaged work under the name the ledger already carries.

## Ordering the unpinned pick — why the ranking lives in the prompt

**Ordering the unpinned pick — the standing work ranking (issue #3981).** Today's
unpinned self-selection is `gh issue list --label ready-for-agent … | .[0]` — it
takes whatever the API returns first, which is **not** a priority order. There is
no numeric priority dial anywhere in the loop to consult: `classes.json` carries
only `cooldownSeconds` (a cadence dial, no priority field), `collect-state.sh`
*counts* `ready_for_agent` without ordering it, and `config/orchestrator/vision.md`
is read by no loop code. So the ranking is applied **here, in the prompt**, the
same way `hydra-sweep` already carries "pick highest unblock count first, NOT
oldest".

## wayfinder_orch — claim, saturation guards, resolution protocol

SKILL.md § `wayfinder_orch` dispatch carries the ticket-type → skill override
and the claim command. This is the rest of the protocol; the dispatch prompt
must carry the claim and the resolution protocol.

This claim is the load-bearing mechanism for BOTH saturation guards. An open,
AFK-typed ticket that is *assigned* is an in-flight worker: `collect-state.sh`
counts assigned tickets into `wayfinder_orch_inflight_global` (the global-cap
input `decide.py` reads) and its frontier query already skips assigned tickets
(`assignees.totalCount==0`), so a claimed ticket is never re-picked. **Skipping
this claim makes both guards inert** — the in-flight counter would read 0 forever
and the same frontier ticket could be dispatched twice. The claim is therefore
step 0 of every `wayfinder_orch` dispatch, not an afterthought.

**Saturation guards (issue #3354, ADR-0029 Decision 2).** Two bounds cap
concurrency, both anchored on the claim above:
- **Global cap — ≤2 concurrent `wayfinder_orch` workers** across all maps.
  `collect-state.sh` counts open, assigned, AFK-typed tickets across every
  approved map into `wayfinder_orch_inflight_global`; `decide.py` suppresses a new
  `wayfinder_orch` dispatch when that counter is ≥2 (frontier-first, then cap —
  purely reading the pre-resolved counter, no network in `decide.py`).
- **Per-map single-flight — ≤1 in-flight worker per map.** Enforced structurally
  in `collect-state.sh`: a map that already has an in-flight (assigned) AFK ticket
  yields NO new frontier pick that tick, so a second worker never starts on the
  same map even if two of its tickets are simultaneously unblocked+unassigned.

HITL-typed tickets (`wayfinder:grilling`, `wayfinder:prototype`) are never
counted and never dispatched here — they surface only in the hydra-review HITL
bucket and resolve via `/wayfinder`.

**Resolution protocol (AC #1) — the worker records the outcome on the map.** When
the dispatched worker finishes the frontier ticket, it MUST, before the ticket is
considered resolved:

1. Post a **resolution comment** on the frontier ticket summarising the verdict /
   PR / findings (`gh issue comment <N> --body '…'`).
2. **Close** the ticket (`gh issue close <N>`) — a `task` ticket closes when its
   PR merges; a `research` ticket closes once its enrichment lands.
3. **Append to the map's `## Decisions so far`** section (edit the map issue body)
   so the map's running ledger reflects the newly-cleared frontier — the next
   `collect-state.sh` tick then surfaces the NEXT unblocked frontier ticket.

The 1h `wayfinder_orch` cooldown means one frontier ticket per fire; the map is
worked one cleared ticket at a time across ticks until its frontier is empty (all
AFK tickets closed), at which point `wayfinder_orch_frontier` reads `none` and the
class idles until a new map or a newly-unblocked ticket appears.

## Fable fallbacks

SKILL.md carries the rule (re-dispatch the identical action on `opus` the
same turn). These are the two causes in full.

**Fallback when Fable 5 is unavailable — model-access error.** The `fable`
alias is not entitled in every environment — a background
`Agent(model="fable", …)` dispatch can die in <1s with *"There's an issue with
the selected model (claude-fable-5) … it may not exist or you may not have
access to it"* (0 tokens, 0 tool uses). When a `fable`-routed dispatch
terminates immediately this way (no tool uses + a model-access error),
**re-dispatch the identical action with `model: "opus"` (Opus 4.8) — do not
leave the class unrun.** This still applies to the `inherit-parent` classes
(`wire_or_retire_target`, `design_qa_target`, `wayfinder_orch`) when the
parent session's saved default is Fable, and to `dev_orch`'s `escalate_model`
hint (still `fable`). If this fallback becomes the steady state rather than an
exceptional path, every such dispatch silently pays Opus prices — demote the
class instead. **Before re-promoting any class back to Fable, verify
entitlement actually returned** — dispatch a throwaway `Agent(model="fable", …)`
smoke test and confirm it doesn't die in <1s with the model-access error above;
don't flip the table back on the assumption that time alone fixed it.

**Fallback when Fable 5 is out of weekly usage credits (issue #4585).** The
same immediate-death shape has a second cause with a different fix: Fable is
the only model whose weekly allowance runs out BEFORE the account-wide limit,
and the CLI then exits 1 with *"You're out of usage credits. Switch to another
model, …"* — a quota 429, NOT a model-access error, and the CLI's own
`--fallback-model` does NOT catch it (empirically falsified on CLI 2.1.280).
When a `fable`-routed dispatch — or the parent session itself — dies with that
notice:

1. **Arm the flag** so the next launch and every same-turn pre-resolution sees
   it:

   ```bash
   curl -sf --max-time 5 -X POST -H 'content-type: application/json' \
     -d '{"line":"out of usage credits"}' \
     http://localhost:4000/api/usage/session-block
   ```

   The server classifies the kind (`out-of-credits`) and arms the MODEL-SCOPED
   exhaustion flag — surfaced as `.reasons.fableExhaustedUntil`, TTL =
   min(now+60min, next Weekly Reset Anchor boundary) — never a session block.
   On a parent-session death the ExecStopPost reap posts this automatically
   (bootstrap.sh greps the journal); post it yourself only for an in-run
   subagent death.
2. **Re-dispatch the identical action on `opus` the SAME turn** — do not leave
   the class unrun and do not wait out the flag for work that is ready now.
3. Apply the pre-resolution rule (Per-class model routing above) for the rest
   of the turn — the next collect-state reads the armed flag either way.

The flag self-clears by TTL: the pace-gate tick after expiry launches the
parent on Fable again and logs `model-fallback: opus->fable reason=flag-expired`.
Verify Fable is actually back before assuming time alone fixed it — the
post-expiry probe is cheap (a 0-token 429 in <0.5s re-arms the flag).

## qa_target — builder-in-flight hold

**Builder-in-flight hold (issue #4653).** Before the selector runs, decide.py
checks whether the pre-resolved needs-qa PR was opened by the dev_target
dispatch that is STILL RUNNING right now (its builder can still push fix-up
commits, moving the head a review would otherwise start against). The join is
by dispatch-token identity, not inference: `target_needs_qa_pr_head` (the PR's
`head.ref`, see the Signal wiring row below) is compared against the live
`state.slots.dev_target` slot's own dispatch token (`worktreeBranch` ->
`dispatch_id` -> `task_id`, whichever resolves a
`<run8>-t<N>-dev_target`-shaped value first). A match holds `qa_target` for
this turn — one `idle` dispatch_decision naming the PR + #4653, plus
`debug.qa_target_builder_inflight` — and the next turn re-resolves once the
slot clears. Any non-token-shaped slot, absent/empty head, or mismatch fails
OPEN: `qa_target` dispatches exactly as it did before this guard existed
(never dead-arm, the #3709 class).

## Preamble rationale

The verbatim preamble blocks, and the rule for which class carries which,
stay in SKILL.md § Worktree-guard preamble. The paragraphs below were written
beside those blocks, so "above" and "below" in them refer to the blocks in
SKILL.md.

### The companion write-fence

The preamble catches cwd-confusion. The companion guard is the PreToolUse
**worktree-write-fence** (issue #549), which catches the more insidious
failure: cwd is correct, but an `Edit`/`Write`/`MultiEdit` tool call
passes a `file_path` that resolves outside the worktree (the bug observed
on the PR #548 dispatch). Operators install it once with `bash
scripts/setup-claude-hooks.sh`; the hook source-of-truth lives at
`scripts/claude-hooks/worktree-write-fence.sh`. When active, the hook
denies any out-of-worktree write from a worktree-cwd session and the
agent must self-correct. `scripts/audit-ghost-writes.py` walks the
JSONL transcript history to quantify ghost-write incidents across past
dispatches (useful as a before/after measurement when the hook is rolled
out).

### Why the `dev_orch` block bans delegation and backgrounded waits

The delegation clause above closes a route the original wording missed (issue
#4052, autopilot run f7b47a0c): a `dev_orch` dispatch on #4041 spawned a
nested `Agent(run_in_background=true)` to run the whole skill invocation,
then ended its turn to "wait for its completion notification" — satisfying
the letter of "poll to a terminal state in the FOREGROUND" while violating
its spirit, because a background child does not keep the parent session
alive. Cost: 75k tokens and ~5.8 min for zero deliverable, plus a race
between the still-live child and the no-PR-stall backstop it triggered.

Motivating incidents (autopilot run 2bcba309, 2026-08-05): a `dev_orch`
dispatch on #3726 did ~9.5 min of real implementation, backgrounded `npm
test`, then ended its session waiting on the test run — no PR existed at reap
time, and the ~165k tokens already spent were silently re-paid by a
from-scratch redispatch on the next turn (see the `dev_orch` no-PR-stall
backstop below, which now catches this case at reap time — but the backstop
exists to limit the blast radius of this failure mode, not to make it
acceptable).

### Why `dev_target` has its own variant

**`dev_target` dispatches carry their OWN forbidden-ending preamble variant
(issue #4196) — ADDITIVE to the self-isolation worktree-guard variant above,
never a replacement for it.** Append verbatim, immediately after the
self-isolation worktree-guard variant, for every `dev_target` dispatch (the
other self-isolated classes carry no delegated-mode child, so this variant is
`dev_target`-only). Unlike the
`dev_orch` block above, this variant does NOT ban the Agent tool
outright: `hydra-target-build`'s own contract requires spawning a delegated
build child for context-window protection (issue #1782), and a flat ban here
would recreate the exact degradation once observed when the flat block was
still applied to `qa_orch` (before issue #4272 gave it its own hazard-scoped
variant below) — it skipped its Standards+Spec Agent fan-out and reviewed both
axes inline as one reviewer (run 8e50460f). What this variant forbids is going
quiet while that delegated child is still running — the gap this issue was
filed to close (autopilot run 155f6d3c: a `dev_target` dispatch spawned a
nested `Agent(run_in_background=true)`, said "I'll relay its summary once it
completes", and ended its turn 101s in with zero deliverable), and the
recurrences that followed even after an earlier draft of this preamble was
present (runs `ad07927f`, `b123538c`: an armed Monitor re-fired, the dispatch
re-armed it and quit again, and a follow-on self-report claimed a push and a
merge that had not actually happened):

### Self-isolated classes

**Self-isolated classes are NOT harness-worktree-isolated (issues #3889, #4476; superseding the #542 framing).** Whether a dispatch is launched with `isolation="worktree"` is data, not prose: `decide.py` stamps `action.isolation` on every dispatch from its `TARGET_ISOLATION` policy (validated at import to cover exactly every Target-scope class), and the `dispatch` action-to-tool entry above reads that field — no class name is hardcoded as the exception. The harness's worktree isolation only covers the orchestrator repo (`~/hydra`); because the Target workspace (`$TARGET_WS`, resolved by `_fragments/target-seam-preamble.md`) is a sibling repo not nested under `~/hydra`, a pinned session can READ it but is refused every git mutation / file write inside it — which made `hydra-target-build` Step 0.6 (`git -C "$TARGET_WS" worktree add …`) categorically fail (2/2 dispatches, issue #3889) and hard-aborted `cleanup_target` on its fetch/ff-merge. The rule: a Target-scope class is `self` iff its playbook mutates the Target tree; pure readers keep `worktree`. Current verdicts (`TARGET_ISOLATION`):

| Class | isolation | Reason |
|---|---|---|
| `dev_target` | self | Step 0.6 `git worktree add` in the Target |
| `qa_target` | self | stash/checkout + e2e:smoke screenshots in the PR's Target worktree |
| `research_target` | self | writes direction docs + branch/commit/push in the Target |
| `cleanup_target` | self | fetch + ff-merge in the Target, knip run (the observed hard-abort) |
| `design_qa_target` | self | route-smoke Playwright run builds/serves and writes artifacts under the app dir |
| `sweep_target` | worktree | GitHub REST only |
| `discover_target` | worktree | curl/journalctl/manifest reads + a cached test run, no git mutation |
| `wire_or_retire_target` | worktree | `git log --follow` + rg reads + `gh issue edit` only |
| `health` | worktree | orchestrator ops (scope both) |

A self-isolated class relies **solely** on the Target worktree it creates with the shared create+verify block (nested under `$TARGET_APP_DIR/.worktrees/` since issue #4177) for isolation, and on the installed `worktree-write-fence.sh` PreToolUse hook for ghost-write protection (the role `isolation="worktree"` plays for the harness-isolated classes). Every self-isolated dispatch MUST create and verify that worktree before its first Target mutation, and runs the git operations its own playbook prescribes against the Target with cwd = `$TARGET_WT` (the fragment's precedence rule). This launch shape is why the self-isolation variant of the worktree-guard preamble above exists (issues #4178, #4476): the default block's `cwd == /home/gabe/hydra → ABORT` clause describes exactly the EXPECTED launch state of a self-isolated class, so carrying the default preamble (or worse, both) is a guaranteed false-abort — carry the variant instead.

### Why `qa_orch` has its own variant

**`qa_orch` dispatches carry their OWN forbidden-ending preamble variant
(issue #4272) — the hazard-scoped rewrite, not the `dev_orch` flat ban above.**
`hydra-qa`'s step 7 review fan-out is an `Agent(*)`-based design by
construction (Standards + Spec sub-agents run as **parallel sub-agents** so
neither pollutes the other's context, `hydra-qa/SKILL.md` lines 48/103), and
every spawn in it already carries the #3789/#3880 blocking mandate
(`run_in_background: false`) plus the step 7.5 incomplete-fan-out exit — a
blocking spawn cannot outlive the turn, so it sits in the same safety class as
a foreground `Bash` call and is mechanically incapable of the #3866 hazard.
`dev_orch` has no equivalent internal blocking mandate, so for that class the
tool ban and the hazard ban still coincide and the flat wording stays
(operator decision, 2026-08-31). Before this variant existed, a `qa_orch`
dispatch reviewing PR #4270 / issue #4257 (autopilot run `8e50460f`, turn 7)
complied with the flat ban's letter by skipping `hydra-qa` step 7's parallel
Standards+Spec fan-out and reviewing both axes itself inline — a competent
single review, but not the two independent, context-isolated reviewers the
design calls for, and nothing errored to surface the degradation.

Filed `hitl-grill` as issue #4272 (self-filed-defect admission rule);
operator decision 2026-08-31 accepted the narrowing, gated on issue #4196
landing first because both rewrite this same preamble section — see the
issue's comment thread for the full reasoning. The run 793fa896 catastrophe
this variant's background-spawn ban cites (9 background reviewer children,
parent worktree reaped by the hourly orphan-prune, ~790k tokens, zero
verdicts) is the reason the ban is unconditional — "for ANY purpose" — while
the `run_in_background: false` fan-out stays permitted: only a *background*
spawn can outlive the parent's worktree.
