# ADR-0007: Decision-brain orchestration for /hydra-autopilot

Status: accepted, 2026-05-15
Issue: [#426](https://github.com/gaberoo322/hydra/issues/426)

## Context

The original `/hydra-autopilot` (issues #405–#413, #422–#423) was a
"model-in-loop" design: every 5 seconds the Claude harness reread the
playbook prose, decided what to do inline, and dispatched a subagent.
That worked at ~10 turns/hour and ~600 lines of inlined heredocs, but it
had three failure modes in production:

1. **Decision drift.** The model would silently re-derive policy from
   the prose each turn — Tier-3 PRs sometimes got auto-merged, sometimes
   queued, depending on which paragraph the model anchored on. There
   was no single source of truth for "what should happen".
2. **No audit trail.** Decisions lived in the model's context window for
   five seconds and then were lost. Post-mortems had to reconstruct
   them from `journalctl` + the heartbeat log.
3. **No regression tests.** "Don't auto-merge Tier-0" was a prose
   sentence — there was nothing to fail a CI run when the rule got
   subtly bent. Every behaviour regression had to be caught at the PR
   level by an operator skim of the diff.

The 9 phase scripts under `scripts/autopilot/` (issue #409) helped, but
the brain itself was still 425 lines of prose interpreted by an LLM
every tick.

## Decision

Move the decision logic into a pure Python function:

```
decide(state, candidates, events) -> Plan
```

where `Plan` is a typed action list (`dispatch`, `auto-merge`,
`queue-decision`, ...) the model executes verbatim.

Concrete shape:

- **L2 brain**: `scripts/autopilot/decide.py` is the single source of
  truth. The model becomes a thin Agent-tool-caller; it never reasons
  about "what to do" inline again.
- **Pipeline**: 6 fixed slots (`dev_orch`, `qa_orch`, `research_orch`
  and the matching `_target` peers). At most one subagent per slot in
  flight. Slot mutation lives in `state.json` (post-migration schema).
- **Signal classes**: 5 cooldown-driven classes (`health`, `sweep_orch`,
  `sweep_target`, `discover_orch`, `discover_target`) track only their
  `last_fired_at` timestamps under `signal_last_fired` — no slots.
  Replaces the legacy `/tmp/hydra-last-*.txt` files with one persistent
  state structure.
- **Event-driven loop**: the model wakes on `TaskNotification` /
  `Monitor` board-change events / a 15-minute wall-clock heartbeat —
  no more 5-second active poll.
- **9 typed action types**: `dispatch`, `queue-decision`, `auto-merge`,
  `apply-operator-approved`, `update-branch`, `reap`, `terminate`,
  `wait`, `wait-for-api`. Each is constructed by a `make_*` helper so
  call sites stay typed.
- **Option C merge policy** (single source of truth: the
  `should_auto_merge()` docstring in `decide.py`): Tier 1/2 always
  auto-merge; Tier 3 auto-merges unless a `scope-justification:` block
  is present in the PR body; Tier 0 mechanical → apply-operator-approved
  (then auto-merge next tick); Tier 0 non-mechanical → queue-decision.
- **8 runtime invariants** in `scripts/autopilot/assert_invariants.py`,
  each tagged INV-001 through INV-008. The guards run on every plan
  before any action executes.
- **Self-heal table** in `scripts/autopilot/self_heal.py`: each
  recognised failure pattern maps to a retry strategy (re-dispatch,
  re-queue, escalate, abort, sleep). 5-retry escalation per pattern
  triggers a global backstop termination.

The 9 phase scripts shipped in #409–#413 stay as decide.py's helpers —
this is a brain-layer replacement, not a full rewrite.

## Consequences

### Positive

- The playbook collapses from 425 lines of prose to ~150 lines of
  scaffolding ("invoke decide.py; execute actions"). The decision
  policy is documented in code, not prose. CLAUDE.md points to
  `decide.py:should_auto_merge` and `self_heal.py` as the canonical
  references.
- Every decision is a JSON blob the harness can log verbatim. Audit
  trail is a `tail -f` away.
- 40+ unit tests pin the policy in `test/autopilot-decide.test.mts`.
  Each INV-NNN has a dedicated test in
  `test/autopilot-invariants.test.mts`.
- Token spend on the brain itself drops to ~0 — the model only spends
  context on prompts to subagents, not on re-reading the playbook.
- Future operator-tweakable knobs (confidence threshold, force-research
  cap, signal cooldowns) become module constants instead of buried
  paragraphs.

### Negative

- One more layer of indirection. Diagnosing why the autopilot didn't
  dispatch now requires reading both the state snapshot and stepping
  through `decide()` mentally.
- The Python module is a new dependency surface. We mitigate by keeping
  it pure (no fs / network), so unit tests cover 100% of the policy.
- Schema migration: `state.json` shape changes. Operator-facing impact
  is limited because the file is recreated on each `bootstrap.sh` run,
  but in-flight slots from a previous-schema run would crash. The
  rollout strategy is: deploy → wait for the current autopilot run to
  drain naturally → next 22:00 timer fires the new bootstrap.

### Risks accepted

- The 5-failure backstop is conservative. A genuinely-broken
  `verification-failure` pattern that's NOT model-fixable will still
  terminate the run after 5 hits, requiring operator review. We prefer
  this over silently loop-burning the budget.
- The `should_auto_merge()` docstring is the policy. We did NOT add a
  separate YAML config — the policy table is small (8 rows) and
  consequential, and reviewing it in a code PR is exactly the gate we
  want.

## Alternatives considered

- **YAML-driven policy.** Rejected: the decision tree branches on
  state (qa_verdict + tier + mechanical + scope-justif) in ways that
  YAML expresses awkwardly. A 30-line function is clearer than a
  100-line YAML.
- **Keep model-in-loop, add a "decision log" tool.** Rejected: solves
  the audit problem but not the drift problem. The model would still
  re-interpret prose every turn.
- **Full Rust/Go rewrite.** Rejected: the brain is ~600 lines of
  decision logic. Python keeps it scriptable and unit-testable without
  adding a new compiled toolchain to the autopilot path.

## Schema-version handshake (issue #434, added 2026-05-15)

Because the brain rewrite changed the on-disk state.json shape, a stale
playbook (e.g. when `scripts/sync-skills.sh` is forgotten after editing
the source playbook under `docs/operator-playbooks/`) can leave the
installed `~/.claude/skills/hydra-autopilot/SKILL.md` mirror describing
the OLD schema while `bootstrap.sh` writes the NEW one. On 2026-05-15
this produced a silent wedge: the model attempted to reconcile the two
worldviews for ~20 minutes with zero observable output.

The fix is a Phase 0 handshake: `bootstrap.sh` writes
`state.limits.schema_version = 2` (the post-#426 schema), and the
playbook carries an `HYDRA_AUTOPILOT_PLAYBOOK_SCHEMA: 2` grep-able
marker near the top. After bootstrap, the model reads both and aborts
with `[autopilot] FATAL: schema mismatch (playbook expects v$X,
state.json v$Y; run scripts/sync-skills.sh)` when they disagree.

Bump procedure (operator-only, single commit):

1. Bump `SCHEMA_VERSION` in `scripts/autopilot/bootstrap.sh`.
2. Bump the `HYDRA_AUTOPILOT_PLAYBOOK_SCHEMA:` marker at the top of
   `docs/operator-playbooks/hydra-autopilot.md`.
3. Update the current-version assertion in
   `test/autopilot-schema-version.test.mts`.
4. Run `./scripts/sync-skills.sh` so the installed
   `~/.claude/skills/hydra-autopilot/SKILL.md` mirror is regenerated.
5. Commit all of the above together.

Anything less makes the next autopilot run abort at Phase 0 — which is
the intended, loud failure mode.

## Related

- ADR-0001 Untouchable Core & gate extraction
- ADR-0004 Self-modification tiers
- ADR-0005 Operator escalation is narrow
- Issue #424 — `GET /api/anchor/candidates` endpoint
- Issue #425 — mechanical-check classifier
- Issue #404 — scope-justification gate
- Issue #395 — per-subagent token caps (`burned_classes`)
- Issue #411 — idempotent reap (`reaped_task_ids`)
- Issue #413 — unattended mode + operator decision queue
- Issue #434 — schema-version handshake (fail-loud on drift)
