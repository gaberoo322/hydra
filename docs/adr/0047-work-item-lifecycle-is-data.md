---
status: accepted
---

# ADR-0047: Work-item lifecycle is data: one writer seam, record-checked gates, a per-issue journal, durable caps that park

Source: wayfinder map #5283. Each of its nine decision tickets (#5284–#5290, #5297, #5307) is the
primary source for one Decision below; read the ticket's resolution comment for the rejected options.
Baseline (#5284, PR #5291, 30d, 375 issues): 21% of issues cycle a lifecycle label 3+ times (#4593:
76 cycles), 55–125 over-threshold stalls/week, 41% first-pass QA proxy. Writers: ~10 deterministic
files, 2 workflows, 54 playbook `gh issue edit` sites. All writes are made by one shared actor, so
attribution is impossible. Re-measure; do not trust these numbers.

Scope: the Orchestrator board (`gaberoo322/hydra`). Every key and type carries the repo, so moving the
Target board onto this later is a swap (ADR-0002), not a redesign.

## Decision

### Decision 1: GitHub labels are current state; Hydra keeps history only (#5285)

The issue's state label is the **only** source of truth for where an issue is. The Hydra record
(journal, claims, cap counts) is history: losing it never loses an issue's position. A label edit made
outside the seam (the operator in the GitHub UI, a workflow) is **accepted and journaled as
`external`, never reverted**. Never build a GitHub→Redis state projection; ADR-0031 calls Redis
transient.

### Decision 2: The state set is closed; everything else is a flag (#5286)

Exactly one state per open issue: `needs-triage`, `needs-info`, `needs-research`, `hitl-grill`,
`needs-tickets`, `ready-for-agent`, `blocked`, `in-progress`, `needs-dev-resume`, `needs-qa`,
`qa-passed`, `ready-for-human`, `parked`, plus terminal closed (completed / not planned).

- `qa-passed` (new) ends the PASS→`in-progress`→`needs-qa` bounce. `in-progress` now means only
  "an agent is working".
- `parked` (new) is where **every** cap exhaustion lands, the #4735 QA round cap included.
  `ready-for-human` keeps exactly its ADR-0005 meaning.
- All other labels (GLM lane, `needs-design-concept`, producer/category, `keep-open`,
  `target-backlog`) are **flags**: orthogonal, free-write, never a state. `wayfinder:*` keeps its own
  native-frontier lifecycle.
- **Human-hold states** (`ready-for-human`, `parked`, `hitl-grill`, `needs-info`): agents and code may
  enter them; **only the operator exits them**.
- Not-planned closes by an agent require a named superseding issue or PR.
- An open issue with 2+ state labels is journaled invalid and goes on the attention feed (no
  auto-pick). An issue with 0 state labels gets `needs-triage`, **except epics** (a `## Sub-issues`
  block or `keep-open`).

The legal transition table is the one in `src/lifecycle/` (data, not prose); #5286 and #5288 are its
sources.

### Decision 3: One writer seam for every Hydra-authored state write (#5287)

`src/lifecycle/` owns the transition table and the re-read → gate → write → verify spine (generalised
from `runVerifiedAction`). It has two adapters:

- the CLI `scripts/lifecycle.ts advance|claim …` for agents, playbooks, Python and shell. It talks to
  GitHub and Redis directly and needs no :4000 service;
- the board HTTP routes, re-pointed at the module (ADR-0034 operator-action registry).

Flags stay outside the seam. Enforcement has three layers:

1. a **blocking lint test**, which is the real gate;
2. a **PreToolUse Bash deny hook**, a sibling of `gh-label-delete-guard.sh`;
3. **reconcile**, which journals whatever still gets through.

The CLI **refuses every human-hold exit** for every caller and has no `--operator` flag. The operator
exits a human-hold state through the confirm-gated board route (journaled `operator-route`) or the
GitHub UI (`external`). A human-hold exit from any other source goes on the attention feed. This is a
**policy** boundary, not authentication; auth is deferred with the API-auth problem.

### Decision 4: Gates are checked against records the seam fetches itself (#5288)

- **Evidence is a pointer.** `--evidence k=v` passes locators (`pr=`, `dispatch=`, comment URL),
  never claimed values. The seam fetches the records and runs a pure per-transition predicate (the
  `evaluateQaMergeGuard` shape). A refusal exits non-zero with a reason code; a failed fetch refuses
  `fetch-failed`. A caller must never fall back to a direct label write after a refusal.
- **The dispatcher records the dispatch.** Autopilot or the GLM drainer fires
  `ready-for-agent → in-progress` *before* spawning the worker, and the seam writes the dispatch claim.
  **Workers never apply `in-progress` themselves.**
- **Judgment transitions** (triage routing, research exits, `→ needs-info`) stay agent judgment.
  They still must pass their mechanical preconditions, plus a per-target `--reason` enum and a
  one-line rationale. Research exits require a `Hydra-Research:` trailer comment.
- **ADR-0005 is a typed enum**: `credentials | external-account | t4-deep-qa-exhausted |
  vision-conflict`. `→ ready-for-human` with any other reason is refused. Off-list escalations
  (e.g. the reap no-PR cap) go to `parked`.
- **`qa-passed` exits are reconcile-fired**, read live at head:
  - red required check or `DIRTY` → `needs-dev-resume`;
  - head moved while green → `needs-qa`;
  - merged → closed;
  - closed unmerged → `ready-for-agent`.
- **A record counts on shape + binding.** It must parse, match the head SHA, match the PR/issue refs,
  and **post-date the issue's entry into its current state**. Records are not signed.
- **Design-concept gate fails closed at dispatch.** When the issue is flagged `needs-design-concept`,
  dispatch requires a fresh `approved` artifact. Otherwise it refuses with
  `design-concept-missing|draft|expired|fetch-failed`.

### Decision 5: The journal is a Redis list per issue, backed by the GitHub timeline (#5289)

- The journal is the append-only LIST `hydra:lifecycle:journal:<repo>#<n>`, behind
  `src/redis/lifecycle-journal.ts` (STD-REDIS-SEAM, `attribution-ledger.ts` shape). Entry `kind` is
  `transition | refused | claim-opened | claim-closed | external`. Each entry carries `source`
  (`cli | operator-route | external | workflow`), actor, evidence, reason, rationale and result.
  **Refusals are journaled.**
- The dispatch claim is a separate `SET NX` key, `hydra:lifecycle:claim:<repo>#<n>`, with no TTL;
  reap, release or the stale arm close it through the seam.
- Retention: no TTL while the issue is open; `EXPIRE 180d` on close; `PERSIST` on reopen;
  `LTRIM` 500.
- No comment mirror. The GitHub label timeline is the backstop and the source of `external`
  transitions. After a journal miss, the seam reads the timeline lazily and tags the result
  `timeline-derived`. There is no bulk rebuild.
- `dispatch-outcome:<cycleId>` stays separate; `dispatchId` joins it to the claim.

### Decision 6: Durable per-issue caps park instead of looping (#5290)

Caps are per arm, plus a total dispatch-claim budget per issue. The limits live in one table in
`src/lifecycle/caps.ts` and can be overridden by env:

| Arm | Unit | Limit |
|---|---|---|
| QA FAIL rounds | PR | 3 |
| dev no-PR resume | issue | 2 |
| QA stall | issue | 3 |
| red-CI forward-fix | PR | 2 |
| stale re-queue | issue | 2 |
| `needs-dev-resume` claims | issue | 4 |
| total dispatch claims | issue | 10 |

- **Counting:**
  - QA FAIL rounds stay counted from `QA-Verdict:` trailers; every other arm counts from the journal.
  - A `timeline-derived` count may park; the park is tagged.
  - **Every dispatch opens a claim, QA included** (`lifecycle claim`, which changes no label).
- **Parking:** over cap, the seam parks **in the same call** and returns `parked:<arm>`. A park:
  - closes the claim;
  - writes `parked` with `reason=cap:<arm>`;
  - posts one escalation comment in a unified format;
  - **leaves the PR open**. Every autopilot arm skips PRs whose closing issue is `parked`.
- **Un-parking:** the operator un-parks; the un-park posts `Hydra-Cap-Reset: by=operator ts=…`, and
  **every** count (journal, trailers, timeline) runs from the latest marker.
- **GLM timeout stays a lane fallback** (`glm-withhold`), not a park.

### Decision 7: Shadow first; enforce on evidence (#5297)

- **Switch:** `lifecycle-seam: shadow|enforce` in git-tracked
  `config/orchestrator/lifecycle-rollout.json`; a missing value means `shadow`. In shadow the seam
  **always writes**, journaling `would-refuse:<reason>` / `would-park:<arm>`. Dispatch claims are real
  in shadow.
- **The `enforce` flip** is an operator-merged PR that requires **all three**:
  1. ~7d and ≥100 seam transitions, with every `would-refuse` triaged and zero attributed to a gate
     bug;
  2. a lint baseline of zero, with the deny hook live;
  3. a reconcile report showing zero invalid open issues.
- **Order:**
  1. seam + CLI + journal + switch, with the lint as a shrink-only ratchet from day one;
  2. dispatcher claims, with workers no longer self-labelling, in the same slice;
  3. the deterministic writers;
  4. the playbooks, by cluster. The deny hook ships with the last of these.
- **Cutover:** one `legacy-backfill` claim for each open `in-progress` issue; reconcile handles the
  rest; no normalisation script.

### Decision 8: The autopilot parent loop handles exceptions only (#5307)

The parent loop already runs `decide.py` plans verbatim, with no override licence (ADR-0007).

- **Move into scripts** the three decisions it still makes mechanically:
  - re-dispatch after a Fable instant death (into `decide.py`/reap);
  - the `route-prs-to-review` PR list (carried on the action);
  - the run-end handoff POST on `wait` with occupied slots (`turn.sh`).
- **Keep two as LLM judgment:** `--notes-file` steering text, and defect filing (`hitl-grill` only).
- The unpinned item pick stays with the dispatched worker.

An **exception** is any parent act that no `decide.py` action dictated. It is recorded in the
**per-run ledger** (not the per-issue journal) as a typed `parent-exception` event, with cause
`invariant-reject | script-error | unrouted-refusal | notes-steer | defect-filed`.

During shadow (Decision 7) the parent still owns every routing decision the seam merely journals; the
shrink is complete only after `enforce`.

### Decision 9: Success is measured on the builder-health panel (ADR-0028)

Three permanent fields ship with this epic, each with a 30d baseline next to #5291:

- **`parentExceptionRate`**: exception turns / total turns, by cause. Its baseline comes from
  replaying run ledgers.
- **First-pass QA yield.**
- **Park rate per cap arm**, from journal `reason=cap:*`.

Cost per merged PR and parent tokens per merged PR wait on run-ledger slice #5075.

## Consequences

- The lint ratchet makes any new direct state-label write fail CI from the first slice. An agent that
  hits it calls `scripts/lifecycle.ts advance`, never an inline `gh issue edit`.
- `docs/agents/triage-labels.md` and `ORCH_BOARD_LABELS` are rewritten from the transition table. The
  dead labels (`backlog`, `refactor-batch-2026-05`, `merge-ready`, `ready-for-merge`,
  `wayfinder:handoff-pending`) are retired.
