---
name: hydra-issue-research
description: Research a Hydra orchestrator GitHub issue — search the codebase and web for context, then enrich the issue description with findings.
when_to_use: "When the user says 'research issue #N', an issue has needs-research label, or more context is needed before an issue can be implemented."
allowed_tools_claude: Read(*) Glob(*) Grep(*) Bash(*) Edit(*) Write(*) WebSearch(*) WebFetch(*)
arguments: [issue_number]
---

# Hydra Issue Research

Research an issue to make it implementable. Searches the hydra codebase and web, then updates the issue with findings.

**Research discipline (upstream `research` idiom, Pocock v1.1).** Investigate the
open questions **against primary sources** — the actual codebase, official
documentation, source, and first-party APIs — not against your prior. Write the
findings as concise, **cited** notes and save them where this repo already keeps
them: the issue body itself (this skill's convention), matching the existing
issue structure rather than inventing a new artifact.

## Process

### 1. Select issue

If `$issue_number` provided, use it. Otherwise:
```bash
gh issue list --repo gaberoo322/hydra --label "needs-research" --state open --json number,title --jq '.[0]'
```

### 2. Read issue
```bash
gh issue view $issue_number --repo gaberoo322/hydra --comments
```

### 3. Extract research questions

From the body, identify what's unknown:
- Missing implementation details
- Unclear interfaces / types
- Unknown dependencies
- Unresolved architectural questions

### 4. Research the codebase

- `~/hydra/CONTEXT.md` — domain vocabulary
- `~/hydra/CLAUDE.md` — conventions
- Grep/glob `~/hydra/src/` for modules, types, functions mentioned
- Read relevant source files
- `~/hydra/docs/adr/` for architectural decisions

### 5. External research

Use web search for:
- External dependencies / APIs
- Best practices for the pattern
- Documentation for tools / libraries

### 6. Update the issue

Post the findings comment. Its **last line** is the machine-readable
`Hydra-Research:` trailer (ADR-0047 D4): `next=` names the state step 7 will
advance to, and `issue=` is this issue's number. Capture the comment URL that
`gh issue comment` prints; step 7 passes it as evidence.

```bash
COMMENT_URL=$(gh issue comment $issue_number --repo gaberoo322/hydra --body "> *Automated research findings*

## Current Implementation
<what exists, modules and interfaces>

## Technical Constraints
<discovered constraints>

## Suggested Approach
<if one emerges>

## Blockers or Dependencies
<must-resolve-first issues>

## External References
<docs, patterns, prior art>

Hydra-Research: issue=$issue_number next=<needs-triage|ready-for-agent|hitl-grill|needs-info|needs-tickets>")
```

### 7. Advance the issue

The only state write is the lifecycle CLI. Never run `gh issue edit` on a state
label, and never fall back to it when the CLI exits non-zero.

```bash
npx tsx scripts/lifecycle.ts advance $issue_number <next> \
  --evidence comment=$COMMENT_URL --reason <reason> --rationale "<one line: what the research settled>" \
  --actor hydra-issue-research
```

Pick `<next>` (it MUST equal the trailer's `next=`) and `--reason`:

| Outcome | `<next>` | `--reason` |
|---|---|---|
| Default: findings ready for human review | `needs-triage` | `needs-retriage` |
| Issue already has `## Files in scope` with paths and no open decision remains | `ready-for-agent` | `research-complete` |
| Unresolvable design choice | `hitl-grill` | `design-decision` |
| Operator answer needed | `needs-info` | `awaiting-answer` |
| Too large for one slice | `needs-tickets` | `epic-needs-slicing` |

Exit codes: `0` = written (in shadow the JSON may carry `wouldRefuse:<code>`;
report it, do not retry). `1` = refused or failed: leave the label as is and
report the code in the run summary / Friction Report. The research-exit gate
needs exactly one `Hydra-Research:` line in a comment posted after the issue
entered `needs-research`, so `research-trailer-next-mismatch`,
`research-trailer-ambiguous`/`-malformed`/`-missing` and `research-trailer-stale`
are fixed by ONE corrected findings comment and one retry.
`scope-section-missing` (`ready-for-agent` without `## Files in scope`) is not
retried: re-advance to `needs-triage`. `2` = usage error, a playbook bug.
