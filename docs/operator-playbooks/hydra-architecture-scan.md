---
name: hydra-architecture-scan
description: Non-interactive architecture-scan wrapper. Composes the upstream improve-codebase-architecture Explore phase against the Orchestrator and emits the surfaced deepening candidates as GitHub issues via hydra-prd / to-tickets — never entering the interactive operator grilling loop.
when_to_use: "When the Orchestrator runs out of eligible work and wants to surface architecture-deepening candidates as tracked issues, or the operator says 'architecture scan' or 'find architecture work'."
allowed_tools_claude: Read(*) Glob(*) Grep(*) Bash(*) Task(*)
arguments: [apply]
claude_only: true
compose_base: _vendor/improve-codebase-architecture.md
supersedes:
  - "### 2. Present candidates as an HTML report"
  - "### 3. Grilling loop"
---

# Hydra Architecture Scan (headless deepening wrapper)

> **Zero `AskUserQuestion`. Ever.** `architecture_orch` dispatches this
> unattended — there is no operator to answer. Both of the base's interactive
> endings (its report step's closing question, its whole grilling loop) are
> **excised at compose time** by the `supersedes:` entries above (#3990), so
> they are absent from the generated skill rather than contradicted by prose
> further down. That distinction is the #3818 lesson: a prose "this wrapper does
> neither" sits *after* the base's own instruction in a top-down read, and loses.

<!-- compose-seam-supersede -->

`hydra-architecture-scan` is the **non-interactive** twin of the upstream `improve-codebase-architecture` skill. It **composes on** that skill's Explore phase — inherited above from the vendored base, not re-described — scopes it to the **Orchestrator** (`~/hydra`), and emits the surfaced deepening candidates as GitHub issues on `gaberoo322/hydra` instead of dropping into the interactive grilling loop. The installed interactive skill is left **completely untouched**: it cannot be dispatched unattended (its grilling loop and its inline `CONTEXT.md`/ADR side-effects both require an operator), so this wrapper exists to give the autopilot a headless entry point that produces tracked work rather than asking questions.

Until #3993 it **hand-copied** those steps as prose, with no compose link and no refresh path — and had already rotted, citing `LANGUAGE.md` / `INTERFACE-DESIGN.md` siblings that do not exist under `improve-codebase-architecture` (upstream moved that vocabulary into the separate `codebase-design` skill). Composition is what makes such rot detectable: `sync-skills.sh` fails loud when a `supersedes:` heading stops resolving, and `npm run vendor:drift` reports a capture that has fallen behind.

This is the gating build artifact (issue #788) for the `architecture_orch` epic (#787): an issue-producing idle fallback that turns wasted autopilot idle capacity (post-#762, the per-run budget is 10M tokens) into self-improvement, in line with the 25% self-improvement floor (ADR-0003) and the operator's stated preference for maintainability over throughput.

The design deliberately **mirrors `hydra-tool-scout`** (the `scout_orch` precedent this epic copies): a depth-first pass over one surface, a filter to keep the issue count sane, structured GitHub issues labelled `needs-triage`, and **no auto-route to `ready-for-agent`**. The operator (or `/hydra-sweep` triage) is the accept point. Because the fallback only produces issues, no merge happens at fallback time, and the existing tier classifier + Untouchable Core (ADR-0001/0004) apply unchanged when the produced issues are later picked up — no new **Modification Tier** carve-out is required.

## The confidence gate (shared with `hydra-cleanup`)

Both idle-backfill scan skills route every emitted candidate through one **confidence gate** — a single, symmetric rule that decides the triage label:

| Confidence | What it means | Triage label | Routing rationale |
|---|---|---|---|
| **Mechanical** (high-confidence) | The acceptance check is **deterministic** — a self-checking "remove X **AND** `npm test` / `tsc` still pass". Provably-unused dead code, deletions/simplifications gated on a green suite. | **`ready-for-agent`** | No human judgment is needed: CI is the merge gate, so a wrong deletion simply fails the suite and the PR is abandoned. The autopilot picks these up hands-off. |
| **Judgment** (softer) | Correctness is an **opinion**, not a green-test check — "this seam feels shallow", a deep-module reorganisation, any deepening whose value is debatable. | **`needs-triage`** | A sweep/operator pass must approve before `dev_orch` grabs it. This keeps the operator in the loop on debatable refactors, honouring *maintainability over throughput*. |

**Deep-module reorganisation is the canonical judgment call → `needs-triage` by default.** It is the deepest, softest category: it carries policy and invariants, and its correctness is a judgment call, not a green-test check. The depth of a candidate inversely correlates with its mechanical verifiability — deeper means softer means judgment means `needs-triage`. A deep-module reorg is **never** auto-routed to `ready-for-agent`, even if a heuristic deems it "clean".

This skill is the **judgment** half of that gate: every deepening candidate it surfaces is a softer judgment call, so it routes to **`needs-triage`** (steps 4 + 4b below). The single mechanical exception is a **genuinely-unreferenced dead-code re-route** (#961): a deletion-test failure with no live callers at all is not a deepening — it is provably-dead code, so it crosses into the mechanical lane (`cleanup-scan` + `ready-for-agent`, the `hydra-cleanup` convention). The mechanical half of the gate lives in `hydra-cleanup`. The two playbooks state the same gate symmetrically.

## What this skill is NOT

- **NOT a modification of `improve-codebase-architecture`.** It **composes** on a vendored capture (`_vendor/improve-codebase-architecture.md`), inheriting the Explore phase and excising the interactive ones. Edit neither the installed skill nor the capture — Hydra behaviour belongs in this overlay; the capture is refreshed only by re-vendoring (`_vendor/README.md`).
- **NOT a code-writer.** It never opens a PR, never edits `src/`, never runs the deepening refactor. It surfaces candidates and files issues. Implementation is a later `hydra-dev` dispatch against a triaged issue.
- **NOT an interactive skill.** **Zero `AskUserQuestion` calls** — see the hoisted rule at the top. Both of the base's interactive endings are excised at compose time, not merely declined here.
- **NOT the autopilot wiring.** The `architecture_orch` signal class, the `arch_fallback_due` / `arch_board_saturated` state signals, `decide.py`, and the autopilot taxonomy table are out of scope here — they land in #789 / #790 / #791. This playbook is the wrapper skill only.

## When NOT to run this

- **When the Orchestrator issue board is already saturated** with deepening-grade proposal issues. Mirror the scout's discipline: if there are already > 10 open issues carrying the `architecture-scan` label (or the board has > 20 open `enhancement` issues generally), **emit nothing** and print a board-saturation skip. The downstream `arch_board_saturated` signal (#789) will be the autopilot's hard suppressor; this in-skill check is a belt-and-braces back-stop so a manual run never floods the board.
- **From inside a `dev_orch` / `dev_target` subagent.** Those work a single issue and must not produce sibling work. This wrapper belongs to the autopilot parent context or a manual operator invocation, same as `hydra-prd`.
- **Against the Target (`~/hydra-betting`).** This wrapper is **Orchestrator-scoped** (`~/hydra`) by design — the epic is about the autopilot improving itself. A target-scoped architecture scan would be a separate skill.

## Inputs

| Input | Source | Notes |
|---|---|---|
| `apply` (positional / `--apply`) | Operator or autopilot dispatch | Dry-run by default. `--apply` (or `apply=true`) actually creates issues on `gaberoo322/hydra`. A dry-run is always safe — it prints the candidates and the rendered issue bodies and stops. |
| Scan surface | Implicit | Always the **Orchestrator** repo at `~/hydra`. Not parameterised — see "When NOT to run this". |
| Open-issue board | `gh issue list` | Read before emitting, for the board-saturation back-stop. |

## Process

**Step 1 is supplied by the base above** — its Explore phase (the friction prompts, the shallow-module questions, the deletion test) is the upstream procedure, inherited rather than restated. What follows is the Hydra divergence: how that exploration is scoped and seeded here, then filter, emit, report in place of the base's excised interactive tail.

### 1 (continued). Explore — Orchestrator scoping and seed

Apply the base's step 1 **to the Orchestrator** (`~/hydra`). Its glossary is `~/hydra/CONTEXT.md` (Target, Orchestrator, Untouchable Core, Pre-merge Gate, Modification Tier, Outcome Holdback, Operator-Required Intervention) and its ADRs are `~/hydra/docs/adr/`.

**Seed the exploration from the import graph, not from file size (issue #2939).** Before walking the tree, generate the deterministic coupling summary and let it target your search at the real seam hubs and cross-group tension:

```bash
npx tsx -e "import('/home/gabe/hydra/src/aggregators/repo-graph.ts').then(m => m.getCouplingReport().then(r => { process.stdout.write(r); process.exit(0); })).catch(e => { console.error(e); process.exit(1); });"
```

This prints the top ≥10 modules by fan-in and the top-5 cross-group coupling pairs — the seam-hub / cross-group-tension signals worth deepening. Prioritise a high-fan-in hub or a heavy cross-group edge over anything surfaced purely by file size. (READ-ONLY over the existing `scanArchitecture()` import graph: no Redis/network connection, safe headless.)

The base's `subagent_type=Explore` walk is scoped **here** to `~/hydra/src/`, `~/hydra/dashboard/src/`, and `~/hydra/scripts/`. Its friction prompts and its deletion test apply as written above — do not restate them, run them.

> **Quota:** like the scout's 5-candidate discovery quota, aim for **3–6** strong candidates. If the codebase is genuinely clean in the area explored, file fewer (or none) and say so — do not pad with theoretical refactors.

### 2. Present candidates as issue input (replaces the base's HTML-report step)

The base wrote a Tailwind/Mermaid HTML report and `xdg-open`ed it for a human; **that step is excised** — nothing reads it unattended, and its closing question is fatal here. Its per-candidate *fields* are what survives, as the step-4 issue schema. Assemble a numbered list of deepening opportunities capturing:

- **Files** — which files/modules are involved (concrete paths under `~/hydra`).
- **Problem** — why the current architecture is causing friction.
- **Solution** — plain-English description of what would change. **Do NOT propose interfaces or write code**: the base defers interface design to its grilling loop, which this wrapper never runs.
- **Benefits** — explained in terms of **locality** and **leverage**, and in how tests would improve (the interface is the test surface).
- **ADR conflicts** — per the base, surface a candidate that contradicts an ADR only when the friction warrants reopening it, and mark it explicitly in the body.

Name the deepened module after a real domain concept from `CONTEXT.md`, not a coined `FooHandler`. Every surviving candidate becomes issue input in step 4.

### 3. Filter (keep the issue count honest)

Drop a candidate before it becomes an issue when ANY of:

- It touches the **Untouchable Core** (`src/untouchable.ts` protected paths: merge gate, rollback, watchdog, cost guardrails) as its *primary* change. Those are operator-only (ADR-0001/0004) and an architecture-scan issue should not steer an agent at them. Note the friction in the report, but do not file it as a deepening issue.
- It duplicates an already-tracked issue in the **shared backfill dedup baseline** (open issues across EVERY backfill label set + issues closed within the last 7 days — NOT just open `architecture-scan` issues). Re-filing the same deepening candidate every idle tick is the exact failure `hydra-tool-scout`'s seen-list guards against; here the lightweight equivalent is the deterministic title/scope-overlap helper below. **This is the load-bearing collision guard for issue #2554:** `hydra-discover` and `hydra-architecture-scan` BOTH fire on the unified `orch_backfill_idle` signal (both in `BACKFILL_SIGNAL_CLASSES`, decide.py:329). The one-per-turn stagger stops same-turn co-fire, but their independent 1h cooldowns + the `BACKFILL_STARVATION_FLOOR` let both dispatch within the same idle HOUR — so an architecture-scan candidate MUST dedup against discover's just-filed `needs-triage` issues (and cleanup's `cleanup-scan` issues), not only against other `architecture-scan` issues, or the same underlying gap gets double-filed.

  ```bash
  # Shared backfill dedup baseline: open across the WHOLE backfill set
  # (architecture-scan + needs-triage + cleanup-scan + enhancement) plus
  # recently-closed — so we see what hydra-discover / cleanup_orch just filed
  # this same idle window, not only our own architecture-scan issues.
  mapfile -t BASELINE_TITLES < <(
    { gh issue list --state open --json number,title --jq '.[] | .title'
      gh issue list --state closed --json number,title,closedAt \
        --jq '[.[] | select(.closedAt > (now - 7*24*3600 | todate))] | .[] | .title'
    } )

  # Per surviving candidate title $CANDIDATE:
  node --experimental-strip-types scripts/ci/issue-dedup.ts \
    "$CANDIDATE" "${BASELINE_TITLES[@]}"
  # → {"duplicate":true,...}  → DROP the candidate (note the friction in the report)
  # → {"duplicate":false,...} → it survives the filter
  ```

  `isDuplicateIssue` (`scripts/ci/issue-dedup.ts`) keys on normalised word-set Jaccard overlap >50% — the SAME deterministic helper `hydra-discover` uses, so the two co-firing classes reach the SAME duplicate verdict against the SAME baseline. After a candidate survives the filter AND is emitted as an issue (step 4), append its title to `BASELINE_TITLES` so later candidates in this run dedup against it too.
- It fails the **deletion test as a pass-through** — deleting the module would just *move* complexity to its callers, not concentrate it. The module *has* live callers; it is genuinely earning its place in the call graph as a pass-through layer, so there is nothing to deepen. Drop it (note the friction in the report).

> **Deletion-test failure is two different findings — split them before dropping.** A candidate that fails the deletion test is NOT always a pass-through. The old rule conflated two distinct outcomes and discarded both; only one of them is actually a drop:
> - **Pass-through (drop)** — the module has live callers; deleting it would push its complexity onto them rather than concentrate it. There is nothing to deepen *and* nothing dead. **Drop**, per the rule above.
> - **Genuinely unreferenced (re-route, do NOT drop)** — the module/export/file has **no live callers at all** (verify with `Grep`/`Glob`: no production import, re-export, or dynamic reference reaches it; test-only consumers do not count as live — mirror the cleanup test-only exclusion). It "fails" the deletion test only because there is no complexity left to concentrate — it is **dead code**, not a pass-through. Do **not** discard it: re-route it to a **dead-code deletion candidate** in step 4b, following the `hydra-cleanup` (slice beta, #960) convention. This is the genuinely-orphaned code the architecture pass used to throw away.
>
> When unsure whether a finding is a pass-through or genuinely unreferenced, treat it as a pass-through and drop it: architecture-scan stays conservative, and a missed dead-code finding is recovered by the deterministic `hydra-cleanup` (`knip`) pass on the next idle tick.

### 4. Emit issues (via hydra-prd or to-tickets — labelled `needs-triage`)

Turn the surviving candidates into GitHub issues. The **fog-gate branch (4.0) runs FIRST** — a pure additive prefix UPSTREAM of the `≥3 → hydra-prd` / `1–2 → to-tickets` routing: a *foggy + big* candidate is charted as a **wayfinder destination-pending map**, not filed as an epic. Only when the fog-gate does **not** fire does the candidate flow UNCHANGED into the two emission paths below.

#### 4.0 Fog-gate branch — chart a destination-pending map (ADR-0029)

**Run this branch before choosing an emission path.** Per [ADR-0029](../adr/0029-autopilot-charts-and-works-wayfinder-maps.md) Decision 1 + Decision 4's routing decision-tree, a *foggy + big* candidate is neither a `needs-triage` issue nor an epic — it is a **map**: an epic is *decided-and-needs-slicing*, a map is *undecided-and-needs-charting*. `hydra-architecture-scan` and `hydra-research` are the only two fog-native producers that get this branch (`discover` / `retro` / `cleanup` keep filing normal issues — ADR-0029 Decision 1).

**Fog-gate predicate — a boolean AND (both must hold; size alone never charts a map):**

1. **Fog** — the candidate self-asserts **≥2 unresolved *decisions*** (open questions the operator has not made — *not* implementation slices). A deepening candidate with a clear, single solution is decided; even if it is large it is an epic (or `needs-triage` issue), NOT a map. A candidate whose *Solution* section still names open design forks (which seam, which owning module, whether to split) is foggy.
2. **Size floor** — the candidate clears the floor: **~≥4 slices OR it spans ≥2 subsystems** (the exact number is a tuning knob).

When the AND holds, chart a map; otherwise fall through to the `≥3 → hydra-prd` / `1–2 → to-tickets` routing below (untouched).

**Dedup BEFORE charting (acceptance criterion 3).** Reuse the SAME shared backfill dedup baseline `BASELINE_TITLES` built in step 3's filter — which is open across every backfill label set (INCLUDING open `wayfinder:map` issues) plus recently-closed — so an overlapping candidate that is already charted produces no second map:

```bash
# BASELINE_TITLES was built in step 3 (open across every backfill label set,
# incl. open wayfinder:map issues, + closed within 7 days). $CANDIDATE = the
# candidate's destination/map title.
node --experimental-strip-types scripts/ci/issue-dedup.ts \
  "$CANDIDATE" "${BASELINE_TITLES[@]}"
# → {"duplicate":true,...}  → an overlapping map/epic already exists; DO NOT chart
# → {"duplicate":false,...} → proceed to chart the map
```

If the candidate is a duplicate, skip charting (note the friction in the report). Otherwise chart the destination-pending map:

```bash
gh issue create --repo gaberoo322/hydra \
  --title "<destination the effort finds its way to>" \
  --label "wayfinder:map" --label "wayfinder:destination-pending" \
  --body "$(cat <<'EOF'
## Destination

<1-2 lines naming the spec / locked decision / in-place change this deepening
effort finds its way to — the thing that is TRUE when the map is done.>

## Not yet specified

<the fog sketch: the ≥2 open design decisions the operator has not made yet, as
prose. This is the frontier that ticket-charting will later resolve — NOT tickets.>
EOF
)"
```

Then append the map's title to `BASELINE_TITLES` so later candidates in THIS run dedup against it too (mirroring step 3's in-run append).

**Invariants (ADR-0029 Decision 1 + 3 + 5):**
- The map carries BOTH labels `wayfinder:map` AND `wayfinder:destination-pending`, and its body is `## Destination` + `## Not yet specified` **ONLY** — **zero tickets**, no `## Sub-issues` block, no `## Decisions so far` content. Draft scope is destination-only: the gate sits between wayfinder's name-destination and map-the-frontier steps, so ticket-charting is the first working action AFTER the operator approves the destination (an amendment strands no tickets).
- The `wayfinder:map` + `wayfinder:destination-pending` label pair is the exact contract the already-merged frontier collector (`scripts/autopilot/collect-state.sh`) reads: it counts a map's AFK tickets as dispatchable ONLY when the map LACKS `wayfinder:destination-pending`. *Approve* = the operator removes the label; the producer emits exactly what the collector recognizes.
- **Off-radar rule (ADR-0029 Decision 3):** the map carries NONE of this skill's usual `enhancement` / `needs-triage` / `architecture-scan` labels — `wayfinder:*` tickets stay invisible to `hydra-sweep` and the orphan-backstop. This is the ONE architecture-scan emission that is NOT labelled `needs-triage` + `architecture-scan`; dispatchability comes from the dedicated map-frontier signal, not from a lifecycle label. The operator drains destination-pending maps via the `hydra-review` bucket.
- The board-saturation back-stop still applies before charting: if the board is already saturated with `architecture-scan` issues, emit nothing (a map is still emission).

#### 4.1 Emission paths (non-fog candidates)

For every candidate the fog-gate did NOT chart, pick by candidate count:

- **≥ 3 related candidates → `hydra-prd`.** Build a `PrdInput` JSON (see `docs/operator-playbooks/hydra-prd.md`) where each candidate is one slice: `whatToBuild` = the **Solution**, `acceptanceCriteria` from the **Benefits** (e.g. "the X module is testable through its interface", "npm test passes"), `filesInScope` = the candidate's **Files**, and `filesOutOfScope` listing the Untouchable Core. Invoke `hydra-prd --apply --input=/tmp/arch-scan-prd.json`. It produces one parent epic + N children, each stamped `Expected tier: N` from `/api/tier`, and parseable by `hydra-epic-close`. **Override the child label**: `hydra-prd` defaults children to `ready-for-agent` — for architecture-scan output the children MUST be `needs-triage` instead (see the labelling rule below). If `hydra-prd` cannot override the child label in your invocation, fall back to the `to-tickets` path so nothing is auto-routed to `ready-for-agent`, then re-label any children with `gh issue edit --add-label needs-triage --remove-label ready-for-agent`.
- **1–2 standalone candidates → `to-tickets`** (or a direct `gh issue create`). Each candidate becomes one issue using the body schema below.

Issue body schema (one per candidate):

```markdown
# architecture-scan: <deepening candidate title>

> Surfaced by `/hydra-architecture-scan` on <ISO date> against the Orchestrator (~/hydra).
> Composed on the upstream `improve-codebase-architecture` Explore phase, headless.

## Files in scope

<concrete paths under ~/hydra that this deepening touches>

## Problem

<why the current architecture is causing friction — in CONTEXT.md + codebase-design vocabulary>

## Solution (plain English — no interface design yet)

<what would change. Deliberately NOT an interface proposal: the upstream skill
defers interface design to its grilling loop, which a triaged pickup
(operator running /improve-codebase-architecture, or a hydra-grill design-concept)
will run.>

## Benefits (locality + leverage + tests)

- Locality: <change/bugs/knowledge concentrate where?>
- Leverage: <what do callers get from the deepened interface?>
- Tests: <how does the interface-as-test-surface improve?>

## Deletion test

<applied: deleting <module> would concentrate complexity across N callers — so it earns its keep / is worth deepening>

## Files out of scope

<the Untouchable Core (src/untouchable.ts protected paths) + anything this candidate must not touch>

---
*Generated by hydra-architecture-scan (Phase A, issue #788). Needs operator/triage review before pickup.*
```

**Labelling rule (HARD):** every emitted issue carries `enhancement`, `needs-triage`, and `architecture-scan`. **NEVER `ready-for-agent`.** The architecture-scan fallback produces *candidate* work; the operator (or `/hydra-sweep` triage) is the accept point. Auto-routing a self-generated deepening straight to `ready-for-agent` would let the autopilot dispatch a refactor it invented against itself with no human checkpoint — exactly the loop the `needs-triage` gate exists to break.

### 4b. Re-route genuinely-dead findings to deletion (cleanup convention)

The step-3 split routes here every finding that failed the deletion test **because it has no live callers at all** (the *genuinely unreferenced* branch, not the pass-through branch). These are NOT deepening candidates — there is no interface to deepen, only dead code to remove — so they do **not** use the architecture-scan issue body or label set above. Instead, emit each as a **dead-code deletion candidate following the `hydra-cleanup` (slice beta, #960) convention**, so it joins the same deterministic-confidence lane as the `knip` findings:

- **Body** — the `hydra-cleanup` issue schema (`# cleanup: remove unused <export|file> ...`), not the architecture-scan schema. Acceptance criterion is the self-checking *"remove X **AND** `npm test` / `tsc` still pass"* — exactly as in `docs/operator-playbooks/hydra-cleanup.md` §3. The "Finding" is *manually surfaced by the architecture pass and verified unreferenced via `Grep`/`Glob`* rather than reported by `knip`; say so in the body so the provenance is honest.
- **Labels (HARD)** — `cleanup-scan` + `ready-for-agent` (the same labels `hydra-cleanup` uses), **not** `architecture-scan` / `needs-triage`. The `cleanup-scan` label is the count seam `collect-state.sh` reads for `cleanup_board_saturated`, and routing to `ready-for-agent` is justified by the *same* confidence logic as cleanup: the acceptance check is deterministic (no references AND the suite/type-checker still pass), so no operator triage gate is needed.
- **Emit path** — one `gh issue create` per finding (independent single-finding tickets, like cleanup), not the `hydra-prd` epic path.
- **Filter parity** — apply the cleanup test-only / entrypoint / Verifier-Core exclusions before emitting: never re-route a test file, a test-only export, a public entrypoint, or a Verifier-Core path as a deletion candidate (mirror `hydra-cleanup` §2). When in doubt, drop rather than re-route.
- **Dedup** — a finding that already has an open `cleanup-scan` issue (path/title match) is a duplicate; skip it. This keeps the architecture pass from re-filing what the deterministic `hydra-cleanup` pass already surfaced.

```bash
gh issue create --repo gaberoo322/hydra \
  --title "cleanup: remove unused file \`src/foo/dead.ts\`" \
  --label cleanup-scan --label ready-for-agent \
  --body-file /tmp/arch-scan-deadcode-N.md
```

This is the recovery the gamma slice (#961) adds: dead code the architecture pass previously discarded with its pass-throughs is now routed to deletion instead of thrown away, joining the high-confidence mechanical lane rather than the judgment-call deepening lane.

### 5. Report (deterministic summary)

Print a single-pass summary — this is the operator's accept/reject surface:

```
hydra-architecture-scan — Orchestrator (~/hydra) — 2026-05-31T19:32:00Z — apply

Explored:  src/, dashboard/src/, scripts/
Candidates surfaced:  6
After filter (untouchable/dup/pass-through):  3
Emitted (deepening):    1 epic (#NNN) + 3 children (#NNN, #NNN, #NNN)  [needs-triage, architecture-scan]
Re-routed (dead code):  1 deletion candidate (#NNN)  [ready-for-agent, cleanup-scan]
Dropped:  2  (1 touches Untouchable Core; 1 failed deletion test as a pass-through)
Board saturation:  ok (4 open architecture-scan issues, under the 10 cap)
```

In dry-run mode the header reads `(dry-run; no GitHub issues created)` and the emitted line shows the rendered bodies instead of issue numbers. This is one pass: the skill does not poll, retry, or watch.

## Rules

- **Zero `AskUserQuestion`** (#776) and **never edit the upstream skill or its vendored capture** — both stated in full above.
- **Deepening candidates land in `needs-triage`, never `ready-for-agent`.** The operator/triage is the accept point. No self-dispatch of self-invented refactors. The single exception is a **dead-code deletion candidate** (a deletion-test failure that is *genuinely unreferenced*, not a pass-through): it re-routes to the `hydra-cleanup` convention (`cleanup-scan` + `ready-for-agent`) per step 4b, because its acceptance check is deterministic — that is mechanically-verifiable cleanup, not a judgment-call deepening.
- **Deletion-test failure is a fork, not a discard.** A *pass-through* (live callers, complexity would move not concentrate) is dropped; a *genuinely-unreferenced* finding (no live callers at all, test-only consumers excluded) is re-routed to a deletion candidate, never thrown away (#961). When unsure, drop.
- **Orchestrator-scoped.** Always `~/hydra`. Not parameterised to the Target.
- **Explore phase only.** Never propose concrete interfaces or write code; Solution descriptions stay plain-English.
- **Don't steer at the Untouchable Core.** A candidate whose primary change is a protected path (ADR-0001/0004) is reported as friction but not filed as an actionable issue.
- **Board-saturation back-stop.** Emit nothing when the board is already saturated with `architecture-scan` issues — belt-and-braces ahead of the autopilot's `arch_board_saturated` signal (#789).
- **Dry-run default.** Only `--apply` creates issues. A dry-run on `gaberoo322/hydra` is always safe.
- **One pass.** Explore → present → filter → emit → report, then exit.

## Manual smoke test

Phase A acceptance flow — the operator runs this before #790 wires the autopilot `architecture_orch` dispatch:

```bash
/hydra-architecture-scan            # dry-run: prints candidates + rendered bodies
/hydra-architecture-scan --apply    # files needs-triage issues on gaberoo322/hydra
```

Expected:

- 3–6 deepening candidates in `CONTEXT.md` + `codebase-design` vocabulary; the step-3 filter drops Untouchable-Core, duplicate, and pass-through ones.
- A **genuinely-unreferenced** deletion-test failure is re-routed as a dead-code candidate (`cleanup-scan` + `ready-for-agent`), not dropped (#961).
- `--apply` files deepening issues labelled `enhancement`, `needs-triage`, `architecture-scan` — **never** `ready-for-agent`.
- Re-running `--apply` against a saturated board emits nothing and prints the skip.
- Both the installed skill and the vendored capture are unchanged (`git status` is clean under each).

## Files

- `docs/operator-playbooks/hydra-architecture-scan.md` — this playbook (source of truth; the skill is generated by `scripts/sync-skills.sh`).
- `docs/operator-playbooks/_vendor/improve-codebase-architecture.md` — the vendored upstream base this overlay composes on (capture convention + refresh recipe: `_vendor/README.md`). **Never edited here.**
- `~/.claude/skills/improve-codebase-architecture/` — the installed interactive skill the capture came from. **Read-only — never edited by this skill.**
- `docs/operator-playbooks/hydra-prd.md` — the `≥3`-candidate emission path (parent epic + children).
- `~/.claude/skills/to-tickets/` (upstream) — the `1–2`-candidate emission path.
- `docs/operator-playbooks/hydra-cleanup.md` — the dead-code deletion convention (`cleanup-scan` + `ready-for-agent`, deterministic "remove X AND test/tsc green" acceptance) that step 4b re-uses for genuinely-unreferenced findings (#961).

## Tier

Tier 3 (ships entirely as a new operator playbook under `docs/operator-playbooks/`; no Untouchable Core, no `src/` change). The PR body carries the live tier classifier's verdict; this footer is informational. The issues this skill later *emits* each carry their own `Expected tier: N` from `/api/tier`, classified at pickup, so the existing gate applies unchanged.
