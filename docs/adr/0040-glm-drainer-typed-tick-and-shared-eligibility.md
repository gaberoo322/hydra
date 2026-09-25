---
status: accepted
---

# ADR-0040: The GLM drainer's decision logic is typed TypeScript that owns the tick, and GLM eligibility is one shared predicate

Date: 2026-09-24
Deciders: Operator + Hydra (wayfinder map #4517, whose three tickets locked the decisions recorded here)
Related: ADR-0032 (the GLM worker lane — the governing record this ADR builds on, and whose `glm-withhold` routing note it supersedes in Decision 4), #4647 (function triage — the facts), #4648 (seam shape), #4651 (shared eligibility), #4649 (the withhold strand bug, folded into #4651), #4286 / #4252 / #4253 / #4254 (the parity-drift incidents that motivated the map), #4371 / #4372 (the existing `src/glm/drainer-driver.ts` bridge this ADR extends)

## Context

`scripts/glm/drainer-loop.sh` is 1,423 lines and 39 functions. The function triage (#4647,
`docs/research/2026-09-23-glm-drainer-function-triage.md`) classified them as 8 pure
decisions, 12 mixed (a pure core wrapped around an effect), 14 single effects, 3 mechanics
and 2 glue. The 54 tests in `test/glm-drainer-loop.test.mts` spawn the real script with fake
`gh`/`git`/`node` on `PATH`, so the bash is *tested* but not *typed*, and no whole-script
test reaches `attempt_one_issue`, the glue function that holds the post-authoring salvage
ladder. Of 18 drainer and lane bugs between 2026-08-05 and 09-15, 8 were eligibility or
routing parity drift, and `pick_eligible_issue` was changed by 4 separate fixes.

The triage also found GLM eligibility implemented in **8 places** (the drainer, the
eligibility sweep, board-state, collect-state, the hydra-dev fragment, the watchdog, the
beachhead report, the dashboard badge) disagreeing in **13 identified ways**, held in step
only by reciprocal `LOCKSTEP` comments that said consolidation was "deliberately left to
operator grilling". That grilling is #4651; this ADR records its outcome.

The lane is live: `hydra-glm-drainer.timer` fires every 15 minutes. Every slice this ADR
governs keeps the timer running and the dry-run mode working.

## Decision

### Decision 1 — TypeScript owns the whole tick, migrated by phase

Neither of the two shapes the seam ticket named. *Plan-then-execute with bash executing*
would keep every `gh`/`git` effect in bash forever. *Function-by-function driver modes*
would turn 14 pure cores into 14 modes, each with a hand-restated JSON contract in bash (a
shallow interface), and leave `attempt_one_issue` in bash indefinitely.

Instead the script's actual control flow is cut into **three phases**, each a deep module,
each one mode on `src/glm/drainer-driver.ts`:

| Phase | Replaces | Returns |
|---|---|---|
| **gate** | operator pause, daily cap, quota block, heartbeat write | `able`, or skip-with-reason |
| **pick** | stale-claim recovery, candidate list, PR dedup, grill-clear, resume-branch detection | issue + admitting reason + resume branch, or idle |
| **finish** | the post-author arm, the salvage ladder, 429 parsing and quota-block recording, preflight, open-PR adopt, label writes, timeout counters, the timeout note | outcome |

Bash calls each mode in place of the functions it replaces. When all three exist, a `tick`
mode composes gate → pick → author → finish, `main()` collapses to flock + heartbeat-on-lock-held
+ invoke, and the replaced bash functions plus the transitional `jq` parsing are deleted in
that same slice. flock stays in bash: ADR-0032 invariant 5 requires kernel auto-release.

### Decision 2 — Each phase is a pure `decide*` core plus a `run*` orchestration over injected deps

One file per phase: `src/glm/gate.ts`, `src/glm/pick.ts`, `src/glm/finish.ts`. Each exports a
pure `decide*` function (typed inputs, typed verdict, no I/O) and a `run*` orchestration that
takes its dependencies through `DriverDeps`, the injection seam `drainer-driver.ts` already
has. Effects move into TypeScript through the existing `src/github/` seams (`issues.ts`,
`prs.ts`, `labels.ts`, `git.ts`), which already take injectable transports; add `git worktree`
and `git ls-remote` helpers to `src/github/git.ts` only where missing. `recover-stale.sh` stays
a subprocess seam because the Claude lane shares it.

The 12 `HYDRA_GLM_DRAINER_*` environment overrides move to one `src/glm/drainer-config.ts`
reading the same names bash reads, so both layers agree mid-migration. Dry-run is the
environment variable `HYDRA_GLM_DRAINER_DRY_RUN=1`, read once there, never an argv flag.

The gate phase writes the heartbeat itself when it returns `able`: the three exclusions are
its own verdict, and splitting them across layers reintroduces the drift this ADR closes. The
pause check reads Redis through `getAutopilotPaused()`; a rejected read is treated as paused
(today's fail-closed direction), a corrupt blob as not paused (what the HTTP endpoint returns
for that case today).

### Decision 3 — File-backed state stays file-backed, owned by TypeScript

The daily cap count, the per-issue timeout counters and the quota block keep today's
`$CAP_DIR` paths and formats. This is behaviour-preserving by design: a live quota block
must survive the cut-over tick. Redis holds only the heartbeat and the published pick
verdict (Decision 5). Moving the files to Redis is a separate issue if ever wanted, not a
slice of this work.

### Decision 4 — Eligibility is two predicates, not one, in `src/glm/eligibility.ts`

The eight copies were answering **two questions** the triage counted as one:

- **Lane membership** — is this issue GLM-lane work? Labels only. `glmLane(labels,
  partitionActive)` returns `glm`, `claude` or `neither` with a reason.
- **Pickability** — given membership, may the drainer author it *now*? `glmPickVerdict(row,
  ctx)` takes the row plus an artifact summary (status, createdAt), open- and merged-PR refs
  and the open-blocker set, and returns `pickable` or a typed skip reason.

Both are pure; neither does I/O; both import their label names from `src/board-labels.ts`,
which stays the vocabulary. Ordering is not a per-row rule and stays in the picker.

The thirteen rulings:

| # | Disagreement | Canonical rule |
|---|---|---|
| 1 | `glm-withhold` strand | `glmLane` returns `claude` when `glm-withhold` is present, as it already does for `glm-ab-control`. **Supersedes** ADR-0032's #3753 amendment 4 sentence "skip it even though it looks glm-eligible" as far as *lane routing* goes: the drainer skips it, and the Claude lane takes it. |
| 2 | fresh **draft** artifact | "in design" — not pickable by either lane; not a strand, collect-state re-grills after 7 days |
| 3 | approved artifact older than 7 days | freshness applies to **both** lanes: pickable requires approved **and** ≤ 7 days |
| 4 | `track:` title with a T1 stamp | never pickable, regardless of stamp |
| 5 | open "Blocked by #X" | skip; the pick phase fetches blockers via `src/github/blockers.ts` |
| 6 | open-PR dedup | `pr-refs.py` union semantics — closing verb, `Refs #N`, or an `issue-N` head branch; TypeScript port in `src/github/` with a source-string parity test; `scripts/ci/epic-close.ts` and `scripts/ci/design-concept-reconcile-check.ts` import it |
| 7 | merged-PR dedup | the drainer's rule (closing verb, or `(#N)` title anchor) applies to **both** lanes |
| 8 | `in-progress` alongside `ready-for-agent` | `neither` |
| 9 | `target-backlog` after `glm-eligible` | `neither` |
| 10 | watchdog false alarm | the pick phase publishes its per-tick verdict to Redis (picked, or idle with a skip-reason histogram); `GLM_DRAINER_STERILE` reads "heartbeat fresh ∧ pickable > 0 ∧ no PR for N ticks" instead of re-deriving the queue in `jq` |
| 11 | degraded collect-state fallback | deliberate fail-open (#3754); `glmLane` encodes `partitionActive=false → claude` |
| 12 | ordering and the 30-row window | out of the predicate; the drainer fetches with the TypeScript lister's default limit of 100 and keeps `updatedAt` ascending, which gives a released issue natural backoff; the Claude lane's anchor order is untouched |
| 13 | badge and beachhead report | the badge consumes `glmLane`; the beachhead report keeps intention-to-treat (a withheld issue stays in the treatment arm — excluding it would bias the comparison toward GLM) and adds a withheld sub-count |

### Decision 5 — Consumers: five direct importers, the rest read a projection

**Direct TypeScript importers:** the eligibility sweep (`isGlmEligibleCandidate` becomes "the
lane rules would admit this row and the label is missing", keeping its A/B coin flip);
board-state (`isGlmWithheldFromClaude` becomes a `glmLane` call); the dashboard badge in
`src/autopilot/work-projections.ts`; the drainer's pick phase; and the two `scripts/ci`
closing-verb regexes.

**Projection consumers (bash):** collect-state keeps reading `glm_withheld` from board-state,
unchanged. The hydra-dev fragment's `GLM_FILTER_JQ` mirror migrates onto that same projection
and its byte-parity mirror test is deleted with it. The watchdog reads the drainer's published
verdict. The beachhead report stays on raw labels.

**Parity tests replace the two `LOCKSTEP` comments:** a golden fixture, seeded from the
existing 12-case `is_grill_clear` table, run through the TypeScript grill-clear arm *and*
collect-state's Python MECHANICAL/TRIVIAL snippets until collect-state migrates; and a
source-string test asserting the TypeScript PR-ref regexes equal `pr-refs.py`'s (the #3965
convention). Both comments are deleted once the tests exist.

### Decision 6 — Logic moves are behaviour-preserving; behaviour changes are separate children

The map's scope rule: this work *moves* logic, it does not change routing policy. Every
phase slice preserves the drainer's observable behaviour. The pick phase is therefore first
composed from the shared building blocks with the drainer's *current* rules, and a separate
child then swaps in `glmPickVerdict` and enumerates each delta from Decision 4 for QA. The
four behaviour-change children — the drainer adopts the canonical rules (rows 3, 4, 5, 6, 8,
9, 12); the Claude lane adopts the merged-PR skip (7); the watchdog consumes the drainer
verdict (10); the badge migrates (13) — are dependency-ordered children of the same epic,
sequenced after the predicate module and the pick phase. Not standalone issues.

**Tracer bullet and order:** gate first (smallest; proves the pattern end to end), then
finish, then pick, then tick. Pick is blocked on the eligibility module: porting the
drainer's current rules verbatim into a *new* copy would build the third copy this ADR
exists to remove.

**Interim contract:** while phases migrate one at a time, bash parses each new mode's JSON
line with hand-written `jq`, as it does for `author` today. Accepted as transitional; the
TypeScript return types are the source of truth, and the contract dies when `tick` lands.

## Consequences

- The open wayfinder ticket #4679 (what replaces a ported phase's fake-binary bash tests)
  is resolved *after* the gate tracer lands, so the tracer shows what a ported test looks
  like. Until then the gate slice ports its decision core to TypeScript unit tests and
  leaves the whole-script groups it still exercises in place; #4679 rules before the finish
  phase ports its tests.
- Rows 1, 3, 4 and 7 of Decision 4 change what issues each lane will work. They are
  policy, decided by the operator in #4651, and they ship as their own children so a QA
  pass can verify each delta on its own.
