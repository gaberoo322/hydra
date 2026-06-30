# ADR-0025: Target gets its own single-realm incident skill (hydra-target-incident)

Status: Accepted
Date: 2026-06-30
Deciders: Operator + Hydra (via the design-concept artifact for issue #2553)
Related: ADR-0013 (swappable single-target builder), ADR-0014 (simplicity discipline), hydra-incident playbook, hydra-target-build playbook (Step 8.6 post-merge health watcher)

## Context

The Operate layer (doctor / incident / digest) was Orchestrator-only. On a
post-merge **Target** regression, `hydra-target-build`'s Step 8.6 alarm-only
post-merge health watcher (`scripts/target/post-merge-health.ts --dispatch`)
spawned the **Orchestrator's** `hydra-incident` skill to investigate.

That dispatch was a cross-realm scope leak in principle. In practice the
`hydra-incident` playbook body was *already* Target-shaped — every command ran
against `~/hydra-betting` (`systemctl --user status hydra-betting-web.service`,
`cd ~/hydra-betting`, `npm test` in the betting tree). So the skill was
nominally Orchestrator-scoped but operationally Target-scoped: a single skill
straddling both realms, with no clean boundary, no Target-specific root-cause
families (venue API drift, settlement/data drift, market-data freshness races),
and a prevention path that wrote the wrong realm's learning surface.

Two options were considered:

- **(a) Bless the cross-realm dispatch explicitly and document it.** Cheapest —
  no new skill. But it preserves a skill that is two things at once and leaves
  the realm boundary implicit, which is exactly the ambiguity that produced the
  leak.
- **(b) Add a thin `hydra-target-incident` scoped to the Target.** One more
  skill, but each Operate-layer incident skill becomes single-realm with a
  crisp boundary, Target-specific root-cause rules, and a prevention path that
  routes to the Target feedback surface.

## Decision

**Option (b).** Each Operate-layer incident skill is **single-realm**:

- `hydra-incident` operates **only** on `~/hydra` (the Orchestrator). It never
  `cd`s into `~/hydra-betting`.
- `hydra-target-incident` (new) operates **only** on `~/hydra-betting` (code
  root `~/hydra-betting/web/src`). It never touches `~/hydra` source.

`hydra-target-build`'s Step 8.6 watcher now dispatches `hydra-target-incident`,
never `hydra-incident`. The alarm-only contract is preserved verbatim: the
watcher never reverts and never blocks a merge, its exit code stays
informational, and the auto-revert paths remain Step 7.5 (deploy failure) and
Step 8 (test regression) only. The dispatch-target string in
`scripts/target/post-merge-health.ts` (the `--dispatch` spawn) and the playbook
move in lockstep — the only behavioral change to that script is the spawned
skill name (`/hydra-incident` → `/hydra-target-incident`).

Cross-realm invariants:

- **Tracker is realm-agnostic; the tree is realm-scoped.** Both incident skills
  file post-mortems on the single tracker `gaberoo322/hydra`; Target
  post-mortems carry the `target-backlog` label. Only the *investigated tree* is
  realm-scoped.
- **Prevention rules stay in-realm.** `hydra-target-incident`'s Phase-5
  prevention writes the **Target** planner/executor feedback surface
  (`config/feedback/to-planner.md`, `config/feedback/to-executor.md`);
  `hydra-incident` writes the Orchestrator's. No cross-realm memory writes.
- **Skills remain generated artifacts.** Both `.md` live under
  `docs/operator-playbooks/` and are produced into `~/.claude/skills/` by
  `scripts/sync-skills.sh`. No hand-edited in-repo `.claude/skills` copies
  (MEMORY drift trap, PR #2551).

## Consequences

- A post-merge Target regression now routes to a skill that knows the Target's
  root-cause families and prevention surface, with no realm ambiguity.
- One additional generated skill to keep in sync; the cost is bounded — it is a
  thin mirror of `hydra-incident` re-scoped to the Target.
- `hydra-incident` is now genuinely Orchestrator-only in intent; a future
  cleanup may tighten its body (which still references `~/hydra-betting`) to
  match, but that is out of scope here (the issue's `## Files in scope` does not
  include `hydra-incident.md`).
- Tier stays **T2** — the change is skill-layer `.md` plus a one-line
  dispatch-name string in the Target post-merge watcher script; no `src/` logic,
  no `ci.yml`/`deploy.yml`.
