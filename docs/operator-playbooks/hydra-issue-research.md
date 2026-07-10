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

```bash
gh issue comment $issue_number --repo gaberoo322/hydra --body "> *Automated research findings*

## Current Implementation
<what exists, modules and interfaces>

## Technical Constraints
<discovered constraints>

## Suggested Approach
<if one emerges>

## Blockers or Dependencies
<must-resolve-first issues>

## External References
<docs, patterns, prior art>"
```

### 7. Re-label
```bash
gh issue edit $issue_number --repo gaberoo322/hydra --remove-label "needs-research" --add-label "needs-triage"
```

The issue returns to triage for human review of findings.
