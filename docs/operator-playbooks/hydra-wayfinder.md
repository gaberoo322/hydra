---
name: hydra-wayfinder
description: Plan a chunk of Hydra work too big for one agent session as a shared map of investigation tickets on gaberoo322/hydra — chart the fog into blocking decision tickets, resolve them one at a time, then hand the cleared map to /to-spec. Adapts Matt Pocock's upstream `wayfinder` skill to Hydra's issue tracker, label vocabulary, and epic conventions.
when_to_use: "When the operator has a large, foggy Hydra initiative to plan (bigger than one session), says 'wayfind', 'chart a map', 'plan this big change', or wants to break a vague initiative into decision tickets before writing a spec. Interactive / operator-driven — not an autopilot dispatch class."
allowed_tools_claude: Read(*) Glob(*) Grep(*) Bash(*) Edit(*) Write(*) WebSearch(*) WebFetch(*) Agent(*)
claude_only: true
arguments: [map, ticket]
---

# Hydra Wayfinder

Plan a chunk of Hydra work **too big for one agent session** as a shared **map**
of investigation tickets on `gaberoo322/hydra`. A loose idea has arrived, wrapped
in fog: the way from here to the **destination** isn't visible yet. This skill
charts that way as issues on the tracker, then resolves the tickets one at a time
until the route is clear and the map can be handed to `/to-spec`.

This is the Hydra-native adaptation of Matt Pocock's upstream `wayfinder`
(`~/.claude/skills/wayfinder/SKILL.md`) — same charting discipline, wired to
Hydra's tracker (`gaberoo322/hydra`), label vocabulary, `Blocked by #N`
convention, and epic format so `hydra-epic-close` can GC a completed map. Read
the upstream skill for the underlying philosophy; this playbook is the wiring.

**Who runs this:** the **operator**, interactively, to plan a big Hydra (or
Target) change before it becomes tracked work — NOT `hydra-autopilot`. Wayfinder
tickets are mostly HITL (human-in-the-loop). It deliberately is **not** an
autopilot class: making the loop *sequence* work off a wayfinder map (respect
`Blocked by`) is a separate, deferred `decide.py` (T3) change.

## Plan, don't do

Wayfinder is **planning** by default: each ticket resolves a *decision*, and the
map is done when the way is clear — nothing left to decide before someone goes
and builds the thing. The pull to just start coding is usually the signal you've
reached the edge of the map and it's time to hand off to `/to-spec` →
`/to-tickets` → `hydra-dev`. Produce decisions, not deliverables, unless the
map's `## Notes` explicitly carries execution into the map.

## Refer by name

Every map and ticket is a GitHub issue with a **title**. In everything the
operator reads — narration, the Decisions-so-far index — refer to a ticket by its
**name**, not a bare `#42`. A wall of `#42, #43, #44` is illegible; names read at
a glance. The number rides *inside* a linked name (`[title](url)`), never stands
in for it.

## The Map

The map is a **single issue** on `gaberoo322/hydra`, labelled `wayfinder:map` —
the canonical artifact. Its tickets are separate issues referenced from the map.

The map is an **index, not a store**: a decision lives in exactly one place — its
ticket's resolution comment — and the map only *gists and links* it. It is loaded
once per session at low resolution.

**Epic-compatibility (reuse, don't reinvent).** The map body carries a
`## Sub-issues` checklist of its tickets in the **exact** format
`hydra-epic-close` parses (`- [ ] #N` / `- [x] #N`) so a completed map is
garbage-collected by the existing epic sweeper — do **not** invent a second epic
format. `hydra-epic-close` closes the map only once **every** referenced ticket is
CLOSED (i.e. the way is clear). If you want the map to persist as a reference
after the `/to-spec` handoff, add the `keep-open` label (epic-close's opt-out).

### The map body

```markdown
## Destination

<what reaching the end of this map looks like — the spec, decision, or in-place
change this effort is finding its way to. One or two lines; every session orients
to it before choosing a ticket.>

## Notes

<domain area; which skills each session should consult (e.g. grill-with-docs for
domain-model questions, prototype for logic/UI questions); standing preferences.>

## Decisions so far

<!-- the index — one line per closed ticket -->
- [<closed ticket title>](url) — <one-line gist of the answer>

## Not yet specified

<!-- in-scope fog too unsharp to ticket yet; graduates as the frontier advances -->

## Out of scope

<!-- work ruled beyond the destination; closed, never graduates -->

## Sub-issues

<!-- hydra-epic-close parses THIS block; keep the `- [ ] #N` shape exactly -->
- [ ] #<n> <ticket title> (`wayfinder:<type>`)
```

### Tickets

Each ticket is a **separate issue** whose body is one question, sized to a single
agent session:

```markdown
## Question

<the decision or investigation this ticket resolves>

Part of wayfinder map #<map-number>.
Blocked by #<a> #<b>      <!-- omit the line entirely if nothing blocks it -->
```

- **Label** each ticket `wayfinder:<type>` — one of `research`, `prototype`,
  `grilling`, `task` (see [Ticket types](#ticket-types)).
- **Blocking** uses Hydra's existing **`Blocked by #N`** body convention (the same
  string `hydra-dev`'s parent-flow unblock logic and `hydra-sweep` already parse)
  — GitHub-native "blocked-by" relationships aren't reliably settable via `gh`, so
  the text convention is the Hydra lane. A ticket is **unblocked** when every
  ticket it names as a blocker is CLOSED.
- The **frontier** = open, unblocked, unassigned tickets — the edge of the known.
- A session **claims** a ticket by assigning it to the driver (`gh issue edit N
  --add-assignee @me`) **before** any work, so concurrent sessions skip it.
- The answer is **not** in the body — it's posted as a resolution comment on
  close. Assets (a research markdown, a prototype snippet) are *linked*, not
  pasted.

## Hydra tracker operations

Concrete `gh` recipes. All against `gaberoo322/hydra`. The bodies use a
**single-quoted** heredoc delimiter (`<<'EOF'`) — deliberately, per the
shell-injection-safety convention: `$var` inside stays literal, so inline the
resolved values with `printf`/`jq --arg`, never rely on expansion inside the body.

**Ensure the labels exist** (idempotent; run once at charting):
```bash
for t in map research prototype grilling task; do
  gh label create "wayfinder:$t" --repo gaberoo322/hydra --force \
    --color BFD4F2 --description "wayfinder $t" >/dev/null 2>&1 || true
done
```

**Create the map:**
```bash
MAP_NUM=$(gh issue create --repo gaberoo322/hydra --label "wayfinder:map" \
  --title "$MAP_TITLE" --body-file /dev/stdin <<'EOF' | grep -oP 'issues/\K[0-9]+'
## Destination
…
## Notes
…
## Decisions so far
## Not yet specified
…
## Out of scope
## Sub-issues
EOF
)
```

**Create a ticket, then a second pass wires blocking** (issues need numbers before
they can reference each other):
```bash
T=$(gh issue create --repo gaberoo322/hydra --label "wayfinder:grilling" \
  --title "$TICKET_TITLE" --body-file /dev/stdin <<'EOF' | grep -oP 'issues/\K[0-9]+'
## Question
…
Part of wayfinder map #<inline the map number literally>.
EOF
)
# second pass: append the Blocked-by line and add `blocked` label if it has blockers
```

**Query the frontier** (open wayfinder tickets whose blockers are all closed):
```bash
gh issue list --repo gaberoo322/hydra --state open \
  --search 'label:wayfinder:research,wayfinder:prototype,wayfinder:grilling,wayfinder:task no:assignee' \
  --json number,title,body,labels
# then drop any whose `Blocked by #N` names an OPEN issue (parse the body, resolve each N's state)
```

**Record a resolution** (on close): post the answer as a comment, close the
issue, tick its box in the map's `## Sub-issues` checklist, and append one line to
`## Decisions so far`. Then unblock dependents whose last blocker just closed
(remove their `blocked` label) — the same unblock shape as `hydra-dev`
parent-flow.

## Ticket types

Every ticket is **HITL** (worked *with* the operator, who speaks for themselves)
or **AFK** (agent drives it alone). A HITL ticket resolves only through the live
exchange — the agent never answers the operator's side (a grilling ticket that
grills itself has broken this; see the facts-vs-decisions rule in `hydra-grill` /
upstream `grilling`).

- **`wayfinder:research`** (AFK) — read primary sources (docs, third-party APIs,
  the codebase, OpenViking) and link a cited markdown summary. Invoke the upstream
  **`/research`** skill. Use when knowledge outside the working tree is needed.
- **`wayfinder:prototype`** (HITL) — raise discussion fidelity with a cheap
  concrete artifact via the **`/prototype`** skill (logic or UI branch). Link the
  prototype; don't paste it. Use when "how should it look / behave" is the crux.
  (Operator-interactive — the `/tmp` worktree-safety fences `hydra-grill` needs
  for BG dispatch don't apply here.)
- **`wayfinder:grilling`** (HITL) — one-question-at-a-time conversation via
  **`/grill-with-docs`** (sharpens against Hydra's `CONTEXT.md` + ADRs and updates
  them inline) or **`/grilling`** + **`/domain-modeling`**. The default type.
- **`wayfinder:task`** (HITL or AFK) — manual work that must happen before a
  *decision* can be made (provision access, move data so its shape is visible,
  sign up for a service so its API can be judged). The one type that *does* rather
  than decides, and it earns its place by *unblocking a decision*. Resolved when
  done; the answer records what was done and any facts (credential location, new
  URLs, row counts) later tickets depend on.

## Fog of war

The map is *deliberately* incomplete — don't chart what you can't yet see. Beyond
the live tickets lies **fog**: decisions you can tell are coming but can't pin down
because they hang on still-open questions. Resolving a ticket clears the fog ahead
of it, graduating whatever's now sharp into fresh tickets — one at a time.

The map's **Not yet specified** section holds that dim view. **Fog or ticket?**
The test is whether you can *state the question precisely now* — not whether you
can answer it now. Ticket when the question is sharp (even if blocked); leave it
in Not-yet-specified when you can't yet phrase it that sharply. Don't pre-slice
the fog into ticket-sized pieces.

## Out of scope

The destination fixes the scope; work beyond it is **out of scope** — not fog,
and it doesn't belong in Not-yet-specified. When a ticket turns out to sit past
the destination, **close it** and leave one line in **Out of scope** (gist + why),
linking the closed ticket. Out-of-scope work never graduates unless the
destination is redrawn (as a fresh effort, not a resumption).

## Invocation

Two modes. Either way, **never resolve more than one ticket per session** —
context stays inside the smart zone, and the map stays collaboratively editable.

### Chart the map  (`arguments: []` — a loose idea)

1. **Name the destination.** Run `/grill-with-docs` (+ `/domain-modeling`) to pin
   down what the map is finding its way to — a spec to hand to `/to-spec`, a
   decision to lock, or an in-place change. The destination fixes scope, so it's
   settled first. Ground it in Hydra's `CONTEXT.md` and relevant ADRs.
2. **Map the frontier — breadth-first.** Grill again, fanning across the whole
   space rather than deep on one thread, surfacing open decisions and first
   takeable steps. **If no fog surfaces** — the way is already clear, small enough
   for one session — you don't need a map; stop and tell the operator to go
   straight to `/to-spec` (or `hydra-prd` for an epic).
3. **Create the map** (`wayfinder:map`): Destination + Notes filled, Decisions-so-
   far empty, fog sketched into Not-yet-specified, empty `## Sub-issues`.
4. **Create the specifiable tickets** as issues; **second pass** wires `Blocked by
   #N` and adds each to the map's `## Sub-issues` checklist. Everything you can't
   yet specify stays in the fog.
5. **Stop.** Charting is one session's work; do not also resolve tickets.

### Work through the map  (`arguments: [map]`, optional `[ticket]`)

1. **Load the map** — the low-res body, not every ticket.
2. **Choose the ticket.** If the operator named one, use it. Else take the first
   frontier ticket in order. **Claim it** (assign to the driver) before any work.
3. **Resolve it** — zoom as needed (fetch related/closed ticket bodies on demand);
   invoke the skill the type names (`/research`, `/prototype`, `/grill-with-docs`).
   If in doubt, grill.
4. **Record the resolution:** post the answer as a comment, close the ticket, tick
   its `## Sub-issues` box, append a one-line gist to Decisions-so-far, and unblock
   dependents whose last blocker just closed.
5. **Graduate fog:** add newly-specifiable tickets (create-then-wire), clearing
   each graduated patch out of Not-yet-specified. If the answer reveals a ticket
   sits beyond the destination, rule it Out of scope rather than resolving it. If a
   decision invalidates other tickets, update or delete them.

The operator may run unblocked tickets in parallel, so expect concurrent edits to
the tracker.

## Handing off — the map is done

When the frontier is empty (no open tickets, no ticketable fog left toward the
destination), the way is clear. Hand off:

- **Destination = a spec** → run **`/to-spec`**, synthesising the map's
  Decisions-so-far (each closed ticket is a primary source) into the spec, then
  **`/to-tickets`** to slice it into tracer-bullet build issues for `hydra-dev`.
  For a multi-issue epic, `hydra-prd` is the Hydra-native producer (parent epic +
  dependency-ordered children stamped `Expected tier: N`).
- **Destination = a locked decision** → the decision lives in the map + its
  tickets; record it as an ADR if it governs future work (`docs/adr/NNNN-*.md`).
- **Destination = an in-place change** → proceed to build; the map's tickets are
  the plan.

Once handed off, `hydra-epic-close` GCs the map when its last ticket closes
(unless `keep-open` is set).

## Reuse & compatibility (do not reinvent)

- **Epic format** — the `## Sub-issues` `- [ ] #N` checklist is exactly what
  `parseEpicReferences()` / `hydra-epic-close` reads. A wayfinder map IS an epic to
  that sweeper. Verified against `docs/operator-playbooks/hydra-epic-close.md`.
- **Blocking** — `Blocked by #N` body text, the same convention
  `hydra-dev`-parent-flow's unblock loop and `hydra-sweep` parse. No new
  mechanism.
- **Producers** — handoff routes through the existing `/to-spec` → `/to-tickets` /
  `hydra-prd` path, not a bespoke issue writer.

## Out of scope (this skill)

- **Autopilot integration.** Wayfinder is operator-interactive. Teaching
  `decide.py` anchor-selection to *sequence* work off a map's `Blocked by` edges is
  a separate, deferred **T3** change (the known "autopilot is dependency-blind"
  gap) — not part of this skill.
- **Target tracker.** This playbook targets `gaberoo322/hydra` (orchestrator
  planning). A Target (`~/hydra-betting`) variant is a future adaptation.

## Rules

1. **One ticket per session.** Never resolve more than one; never chart *and*
   resolve in the same session.
2. **HITL means HITL.** Never answer the operator's side of a grilling/prototype
   ticket. Facts you can settle by exploring the codebase are facts (resolve them
   yourself); decisions belong to the operator (ask).
3. **Refer by name**, never a bare number, in everything the operator reads.
4. **The map is an index** — gist and link; never restate a decision the ticket
   already holds.
5. **Keep the `## Sub-issues` block epic-close-parseable** — `- [ ] #N` / `- [x]
   #N`, one per ticket. Breaking the shape orphans the map from GC.
6. **Single-quoted heredoc bodies** — inline resolved values; never rely on
   `$var` expansion inside a `<<'EOF'` body.

## Skill files

The canonical source is `docs/operator-playbooks/hydra-wayfinder.md`. The deployed
copy at `~/.claude/skills/hydra-wayfinder/SKILL.md` is machine-generated by
`scripts/sync-skills.sh` on every master deploy — never edit it by hand.
