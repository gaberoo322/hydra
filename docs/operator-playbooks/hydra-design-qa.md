---
name: hydra-design-qa
description: Non-interactive visual QA of the Target UI that screenshots every rendered route, judges each against the design-language ADR rules, and files at most three deduped needs-triage backlog items citing the rule violated; a healthy UI files nothing.
when_to_use: "When the periodic design-QA cadence is due, or the operator says 'design QA the target' or 'review the UI against the ADR'."
allowed_tools_claude: Read(*) Glob(*) Grep(*) Bash(*)
claude_only: true
---

# Hydra Design-QA (headless Target visual-QA pass)

`hydra-design-qa` is the **judgment** arm of the Target UI-quality loop (epic **#2732**).
The loop's **mechanical** rules land in CI — nav-spine + label checks (#2737), the styling
lint ratchet (#2738), the route-smoke render/weight/section ceilings (#2733). This skill
reviews the **[judgment]** rules a static check cannot: whether a page *looks* consistent with
the idiom, whether a section actually serves the page's declared question, and whether an
empty-state's wording is honest.

It is the periodic (weekly) sibling of the per-PR visual QA (#2740). Where per-PR visual QA
grades a single diff's before/after, this pass sweeps the **whole rendered surface** on a
calendar cadence to catch drift that accumulated across many merges.

## What it is vs. what it is not

| | mechanical CI (#2733/#2737/#2738) | `/hydra-design-qa` (judgment) |
|---|---|---|
| Input | route-smoke HTML + ESLint | the **screenshots** of every nav-registry route |
| Decision | deterministic pass/fail | an **opinion** graded against the ADR's [judgment] rules |
| Output | red CI check | ≤3 deduped **needs-triage** Target-backlog items with screenshot evidence |
| Edits the Target tree? | n/a | **never** — it only reads + files backlog items |
| Cadence | per-PR / per-push | 7d (`design_qa_target_due`) |

This skill **never edits the Target working tree** and **never files a `ready-for-agent`
task**. Judgment findings are candidates for a human/triage pass, not self-authorised code
work — it files **`needs-triage`** items (the same confidence-routing discipline `wire_or_retire_target`
uses, epic #2720). A downstream triage/dev pass decides what, if anything, to change.

## Trigger

Dispatched by the autopilot `design_qa_target` signal class (issue #2739) when
`collect-state.sh` emits **`design_qa_target_due`** — true whenever the Target board is
reachable AND not saturated (there is always UI to review, so the "due" predicate is just
"board reachable + capacity"). The **7d class cooldown**
(`SIGNAL_COOLDOWNS["design_qa_target"]`, seeded in `bootstrap.sh`'s `signal_last_fired` so it
survives the pace-gate relaunch — the #2575 cooldown-bootstrap bug class) is the primary
cadence control, mirroring `scout_orch`'s weekly calendar discipline.

**Saturation backstop.** `collect-state.sh` also emits **`design_qa_target_saturated`** — true
when **more than 5** open items carrying the stable **`design-qa`** label already sit in a
Target-backlog lane other than `done`. `decide.py` checks it **FIRST** (before the cooldown),
so a board already piled with un-triaged design-QA findings suppresses the pass: the loop must
not re-review a UI into an ever-growing triage pile. The emit runner in this skill re-checks
the cap as a belt-and-braces back-stop.

The dispatch carries **`apply: true`** (the #1078 lesson — a dry-run-default skill dispatched
headlessly without it is a silent no-op that files nothing) and **`max_items: 3`** (the per-run
finding cap). It **omits the model param** so the pass inherits the parent session's model (the
#1093 fallback): this is judgment work, and the documented Haiku-premature-exit failure mode
(a low-tier model narrates "standing by" and exits in seconds, files nothing) makes a low tier
unsafe here.

## The review loop

Single realm: **`~/hydra-betting/web`** (the Target code root; anchor paths are web-relative).

1. **Enumerate routes.** Read `web/src/components/nav-registry.ts` — the single source of the
   rendered nav spine (the four tabs: Portfolio / History / Markets / System) plus any routes
   it declares. That is the slice-1 screenshot set. Do NOT screenshot legacy hash-anchor
   quick-links the redesign is culling (ADR §1) — the registry is the authority on what is
   *supposed* to render.
2. **Capture.** Render each route against a **seeded-empty DB** (the same posture #2733's
   Playwright pass uses, so empty-states are visible) and capture a screenshot per route.
   Reuse the route-smoke harness's launch path rather than standing up a bespoke server.
3. **Judge each page against the ADR's [judgment] rules** — read
   `~/hydra-betting/docs/adr/0005-design-language.md` and grade against exactly these:
   - **§2 [judgment] — styling consistency.** Does the page *look* consistent with the
     hand-rolled dark-Tailwind idiom (card spacing, hierarchy, status-pill usage)? Ad-hoc
     color drift is the #2738 lint's job; this is the *visual* read.
   - **§3 [judgment] — density / one question per page.** Does every section actually serve the
     page's declared question? A section that answers a *different* question is clutter even if
     the page is under the mechanical weight/section ceiling.
   - **§5 [judgment] — empty/degraded-state honesty.** Is the placeholder wording honest about
     *why* it's empty (real reason, not a vague "no data")? Is the shared `EmptyState`/degraded
     idiom used rather than a hand-rolled blank?
   Agents **must not re-litigate** these ADR decisions — implement them, don't argue them.
4. **File ≤3 findings.** Keep only the **3 highest-confidence** violations, oldest-surface
   first. For each, file **one `needs-triage`** Target-backlog item stamped with the stable
   **`design-qa`** label, whose body contains: the route, the **specific ADR section number +
   rule** violated (e.g. "§3 density: the Markets page's 'recent settlements' section does not
   serve 'what can I bet on now?'"), and the **screenshot** as evidence. **Dedup** against open
   `design-qa` items first — never file a second item for a route+rule that already has one.
5. **Healthy UI → file nothing.** If no page violates a [judgment] rule, the run files zero
   items and exits clean. That is a success, not a no-op to be padded to ≥1.

## Guardrails (fail closed)

- **Never edit the Target working tree.** Read + screenshot + file backlog items only.
- **Never file `ready-for-agent`.** Judgment findings route **`needs-triage`** — a human/triage
  pass owns the decision (epic #2720 confidence routing).
- **Respect the ≤3-per-run cap and the >5-open saturation backstop.** Both are machine-enforced
  at the dispatch seam (`max_items` / `design_qa_target_saturated`); the emit runner re-checks
  them so a stale signal can't flood the board.
- **Dedup before filing.** One open item per (route, ADR-rule) pair.
- **Only the mechanical rules belong in CI.** If a finding is really a mechanical violation
  (nav spine, label mismatch, ad-hoc color, weight ceiling), note that it belongs to
  #2737/#2738/#2733 — do not duplicate a CI-owned check as a judgment item.

## Dispatch wiring

Dispatched by the autopilot `design_qa_target` signal class on the
`design_qa_target_due` signal, at a 7-day cooldown. Tracked by issue #2739 under
parent #2732 (the Target UI-quality loop).
