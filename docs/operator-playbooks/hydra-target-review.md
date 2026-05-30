---
name: hydra-target-review
description: Interactive operator review of target project work items needing human attention — triage lane, blocked items, reframe queue, and prior failures. Presents items one-by-one with recommended resolutions.
when_to_use: "When user says 'review target work', 'what's stuck', 'check blocked items', 'review backlog', or wants to clear items needing operator decisions."
allowed_tools_claude: Read(*) Glob(*) Grep(*) Bash(*) Edit(*) Write(*)
---

# Target Project Operator Review

Interactive session to resolve target project (`~/hydra-betting`) work items needing human judgment. Tracked in Redis via the Hydra API, not GitHub.

## Categories

1. **Triage** — new items awaiting review before backlog promotion
2. **Blocked** — cannot proceed
3. **Reframe queue** — failed 2+ times, need diagnosis or scope change
4. **Prior failures** — failed once, may need narrowing before retry

## Procedure

### 1. Gather

```bash
hydra backlog ls
hydra queue ls
hydra backlog counts
docker exec hydra-redis-1 redis-cli LRANGE hydra:anchors:reframe-queue 0 -1
docker exec hydra-redis-1 redis-cli LRANGE hydra:anchors:prior-failures 0 -1
```

Filter to: triage items, blocked items, reframe queue items, prior failure items.

### 2. Present

```
## Target work needing attention (N total)

### Triage (M) — new, awaiting review
| # | Title | Age | Source |

### Blocked (K) — cannot proceed
| # | Title | Age | Blocked reason |

### Reframe queue (J) — failed 2+ times
| # | Title | Attempts | Last failure |

### Prior failures (L) — failed once
| # | Title | Last failure reason |
```

Then: "I'll walk through these one at a time. Ready?"

### 3. Review loop (one item at a time)

1. Show full item — title, description, context, metadata, failure history
2. Identify category
3. **Explore the codebase** if item references files / functions / modules in `~/hydra-betting`
4. Concise summary — what it is, why it's stuck
5. Offer 2–4 resolution options (below)
6. Include recommendation with reasoning
7. Wait for operator's choice
8. Execute via API
9. Move on

**Transcript deep-link (issue #695).** When a prior-failure or reframe item
references the subagent dispatch that produced it (the failure history names
the dispatching session), include a transcript deep-link line so the operator
can read the full `hydra-target-build` conversation in one click:

```
- transcript: http://localhost:4000/dispatch/<sessionId>/transcript
```

`<sessionId>` is the harness session id (the unified active-dispatch row's
`id` for `source === "subagent"`). The link resolves a known dispatch even
after its Now-page row expires; a registered dispatch whose JSONL was cleaned
up renders a "transcript not available" state with metadata, never a 500.
Emit one line per dispatch the item references; omit it for items with no
associated subagent dispatch.

### 4. Resolution options

#### Triage
- **Approve to backlog** — `hydra backlog move <id> backlog` or `hydra backlog approve <id>`
- **Promote to queued** — high-priority, run next cycle
- **Needs refinement** — discuss to sharpen, update description, then approve
- **Reject** — out of scope; move to done with note, or delete

#### Blocked
- **Unblock** — blocker resolved or no longer relevant. `hydra backlog move <id> queued`
- **Still blocked (clarify)** — update reason with current context
- **Restructure** — work around blocker by changing scope. Update item, then unblock.
- **Abandon** — `hydra backlog move <id> done`

#### Reframe queue (failed 2+)
- **Narrow scope** — discuss, rewrite as smaller task, push back: `hydra queue add ...`
- **Provide implementation approach** — operator has insight. Add context/hints, push back.
- **Split into steps** — `hydra raw POST /backlog '{...}'` per child
- **Abandon** — repeated failure means infeasible / not worth cost

#### Prior failures (failed once)
- **Retry as-is** — transient; `hydra queue add ...`
- **Narrow scope** — reduce criteria/files, retry
- **Add guidance** — implementation hints, retry
- **Escalate to reframe** — failure suggests deeper problem
- **Abandon**

### 5. Executing resolutions

```bash
# Move lanes
hydra backlog move <id> <lane>

# Push to work queue (retry / reframe)
hydra queue add "<title>" -d "<details>"

# Create new backlog item (split)
hydra raw POST /backlog '{"title":"<title>","description":"<desc>","lane":"backlog"}'

# Update item metadata
hydra raw PATCH /backlog/<id> '{"description":"<updated>"}'
```

### 6. Wrap-up

```
## Session summary

| ID | Title | Was | Resolution | Now |

Approved: W | Unblocked: X | Reframed: Y | Abandoned: Z | Skipped: S
```

Note any items split into new work, listing new IDs.

## Rules

- One item at a time. No batching.
- Explore `~/hydra-betting` before asking obvious questions — if item references a module / file / function, read it first.
- Check `config/direction/priorities.md` for alignment with operator priorities.
- "Skip" / "later" → move on without action.
- Track before/after as you go — don't re-query at end.
- Narrowing scope or guidance: be specific (files, functions, criteria) — not "make it smaller."
- Reframe items: always show what was attempted previously so operator can decide informed.
