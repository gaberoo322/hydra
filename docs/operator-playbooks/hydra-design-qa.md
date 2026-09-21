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

It is the periodic (weekly) sibling of the per-PR visual QA (#2740): where that grades a
single diff's before/after, this pass sweeps the **whole rendered surface** on a calendar
cadence to catch drift accumulated across many merges.

## Resolve the Target seam (run this first)

@include _fragments/target-seam-preamble.md

**Dormancy check (issue #4528).** The pass is inert without a design-language contract —
re-check the SAME glob `collect-state.sh` gates the due signal on, before any other work:

```bash
# Zero matches = no design-language ADR yet (writing one is Target backlog,
# not ours): exit 0 BEFORE any build/serve/screenshot work. Never invent rules.
if ! ls "$TARGET_WS"/docs/adr/*design-language*.md >/dev/null 2>&1; then
  echo "design-QA dormant: no docs/adr/*design-language*.md under $TARGET_WS — nothing to grade."
  exit 0
fi
```

## What it is vs. what it is not

| | mechanical CI (#2733/#2737/#2738) | `/hydra-design-qa` (judgment) |
|---|---|---|
| Input | route-smoke HTML + ESLint | the **screenshots** of every registered route |
| Decision | deterministic pass/fail | an **opinion** graded against the ADR's [judgment] rules |
| Output | red CI check | ≤3 deduped **needs-triage** Target-backlog items with screenshot evidence |
| Edits the Target tree? | n/a | **never** — it only reads + files backlog items |
| Cadence | per-PR / per-push | 7d (`design_qa_target_due`) |

This skill **never edits the Target working tree** and **never files a `ready-for-agent`
task**: judgment findings are candidates for a human/triage pass, not self-authorised code
work — it files **`needs-triage`** items (the confidence-routing discipline
`wire_or_retire_target` uses, epic #2720).

## Trigger

Dispatched by the autopilot `design_qa_target` signal class (issue #2739) when
`collect-state.sh` emits **`design_qa_target_due`** — true only when ALL THREE hold: the
Target board is reachable, the board is not saturated, and at least one file matches
`docs/adr/*design-language*.md` under the Target workspace (issue #4528: no design ADR ⇒
nothing to grade ⇒ the class stays dormant instead of paying a no-op dispatch every cycle;
the advisory `design_qa_target_adr_present` key makes that dormancy observable). The **7d
class cooldown** (`SIGNAL_COOLDOWNS["design_qa_target"]`, seeded in `bootstrap.sh`'s
`signal_last_fired` — the #2575 cooldown-bootstrap bug class) owns the cadence, mirroring
`scout_orch`'s weekly calendar discipline.

**Saturation backstop.** `collect-state.sh` also emits **`design_qa_target_saturated`** —
true when **more than 5** open items carrying the stable **`design-qa`** label sit in a
Target-backlog lane other than `done`. `decide.py` checks it **FIRST** (before the
cooldown): a board piled with un-triaged findings suppresses the pass, so the loop never
re-reviews a UI into an ever-growing triage pile. The emit runner re-checks the cap.

The dispatch carries **`apply: true`** (the #1078 lesson — a dry-run-default skill dispatched
headlessly without it is a silent no-op) and **`max_items: 3`** (the per-run finding cap). It
**omits the model param** so the pass inherits the parent session's model (the #1093
fallback): this is judgment work, and the documented Haiku-premature-exit failure mode makes
a low tier unsafe here.

## The review loop

Single realm: the seam-resolved Target — app-tree facts under **`$TARGET_APP_DIR`**, docs
and filing against **`$TARGET_WS`** / **`$TARGET_GH_REPO`**.

1. **Discover the contract.** The design-language ADR is whatever
   `docs/adr/*design-language*.md` matched in the dormancy check. Read it. The grading set
   is exactly the rules the ADR itself marks **[judgment]** (or, untagged, the rules not
   mechanically checkable). This playbook restates none — the ADR is the authority, and
   agents must not re-litigate its decisions.
2. **Enumerate routes.** Take the route registry the ADR names; if it names none, fall back
   to the routes present in the Target app router under `$TARGET_APP_DIR` and say so in the
   run report. The registry is the authority on what is *supposed* to render.
3. **Capture.** Render each route with empty/degraded states visible (a seeded-empty DB
   where the Target's own harness supports it) and screenshot each. Reuse the Target's own
   route-smoke/screenshot harness when one exists rather than standing up a bespoke server;
   otherwise screenshot the live pages under `$TARGET_WEB_URL` and note the fallback.
4. **Judge each page** against the ADR's judgment rules — the visual-consistency read, the
   one-question-per-page density read, the empty-state honesty read — as the ADR frames
   them, not as any orchestrator doc restates them.
5. **File ≤3 findings.** Keep only the **3 highest-confidence** violations, oldest-surface
   first. For each, file **one `needs-triage`** Target-backlog item via
   `gh … --repo "$TARGET_GH_REPO"` stamped with the stable **`design-qa`** label, whose
   body contains: the route, the **specific ADR file + section + rule** violated, and the
   **screenshot** as evidence. **Dedup** against open `design-qa` items first — never file
   a second item for a route+rule that already has one.
6. **Healthy UI → file nothing.** No judgment-rule violation ⇒ zero items, clean exit. That
   is a success, not a no-op to be padded to ≥1.

## Guardrails (fail closed)

- **Never edit the Target working tree.** Read + screenshot + file backlog items only.
- **Never file `ready-for-agent`.** Judgment findings route **`needs-triage`** — a
  human/triage pass owns the decision (epic #2720 confidence routing).
- **Respect the ≤3-per-run cap and the >5-open saturation backstop.** Both are
  machine-enforced at the dispatch seam; the emit runner re-checks them.
- **Dedup before filing.** One open item per (route, ADR-rule) pair.
- **Only the mechanical rules belong in CI.** A mechanical violation belongs to the
  Target's own CI — never duplicate a CI-owned check as a judgment item.
- **Never invent rules.** A failed dormancy check means report dormant and exit 0 — a run
  with no ADR grades nothing.

## Dispatch wiring

Dispatched by the autopilot `design_qa_target` signal class on the
`design_qa_target_due` signal, at a 7-day cooldown. Tracked by issue #2739 under
parent #2732 (the Target UI-quality loop).
