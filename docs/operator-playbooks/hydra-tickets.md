---
name: hydra-tickets
description: AFK overlay on the upstream to-tickets base — turns a resolved plan into one parent epic plus N tracer-bullet child issues on gaberoo322/hydra, rendered deterministically through the hydra-prd renderer library. Zero AskUserQuestion.
when_to_use: "When a resolved plan or research finding needs to become tracked work, or the operator says 'ticket this'."
allowed_tools_claude: Read(*) Glob(*) Grep(*) Bash(*)
claude_only: true
compose_base: _vendor/to-tickets.md
supersedes:
  - "### 4. Quiz the user"
  - "### 5. Publish the tickets to the configured tracker"
---

# Hydra Tickets

> **Composed skill (ADR-0030 Decision 2, issue #3992).** The thin Hydra **AFK
> overlay** on the vendored upstream `to-tickets` base. Upstream supplies the
> tracer-bullet discipline — vertical slices, blocking edges, expand–contract for
> wide refactors (base steps 1–3, kept intact). This overlay supplies the Hydra
> publish contract. `hydra-prd` is the **called renderer library**
> (`scripts/ci/hydra-prd-render.ts`), never a dispatch identity.

Two base sections are **excised at compose time** by the `supersedes:` entries
above, because each is actively wrong for an AFK dispatch:

- **Base step 4, "Quiz the user"** — an iterate-until-approved loop. A
  `tickets_orch` dispatch has no operator to quiz. Per ADR-0030 Decision 3 the
  granularity gate resolves from the **artifact** instead: the resolved plan,
  design concept, or research finding named in the dispatch. **Zero
  `AskUserQuestion` calls.** If the artifact is too thin to slice confidently,
  stop and report — never invent slices to fill a quota.
- **Base step 5, "Publish…"** — upstream publishes prose bodies itself and says
  to apply `ready-for-agent` to every ticket. Both are wrong here (below).

## Why the publish step must be superseded, not layered on

**Hydra's autopilot is dependency-blind.** Anchor selection does not read
blocking edges, so a `ready-for-agent` label on a *blocked* slice makes autopilot
grab work whose prerequisites are unmet. Upstream's "apply `ready-for-agent`
unless instructed otherwise" is therefore a defect in this context.

**Label only the slices that are actually unblocked** — in practice slice 1. Every
slice with a `dependsOn` edge is filed WITHOUT `ready-for-agent`; the operator (or
a future epic-driver) promotes each as its blocker merges. This is the label-gated
cadence epic #3988 itself uses.

## Publish through the renderer

Bodies are rendered by the pure library, not written free-hand, so they stay
deterministic and unit-tested (`test/hydra-prd-template.test.mts`).

1. **Build a `PrdInput`** — `title`, `problem`, `rationale`, `slices[]`, optional
   `expectedGlossaryTerms` and `sourceRef`. Each slice needs `title`,
   `whatToBuild`, `acceptanceCriteria[]`, and **`filesInScope[]`**.
   `filesInScope` is REQUIRED: the `issue-label-validation` workflow reverts
   `ready-for-agent` on an issue without a `## Files in scope` section (#396).
   List paths as **plain text, never in code spans** — every code span in a scope
   section becomes an entry and `scope-check` then fails the implementing PR.
2. **Validate before creating anything** — `validatePrdInput()`. A non-empty
   return is a HARD STOP: report the problems and create no issues. The validator
   enforces ≥3 slices (#514).
3. **Two-pass create.** Render the parent with placeholder child references and
   `gh issue create` it; create each child in dependency order with
   `renderChildBody()`, resolving `dependsOn` indices to the real issue numbers;
   then re-render the parent with the real numbers and update it. The two passes
   are what keep cross-references resolvable without a back-edit per child.
4. **Labels** — `parentLabels()` for the epic, `childLabels(slice)` for each
   child, plus `ready-for-agent` on unblocked slices ONLY (above).
5. **Stamp the tier** — `Expected tier: N` per child from `GET /api/tier`, the
   single tier authority. Never self-classify by path.

The parent body must stay parseable by `hydra-epic-close`, which sweeps an epic
closed once every referenced child is CLOSED — keep the `## Sub-issues` checklist
shape the renderer emits.

## Carried forward from the excised base step 5

Two pieces of upstream guidance live in the section that is excised, and remain
binding:

- **Avoid specific file paths and code snippets in ticket prose** — they go stale
  fast. The `filesInScope` field is the structured exception.
- **A prototype snippet may be inlined** only when it encodes a decision more
  precisely than prose can (state machine, schema, type shape). Trim to the
  decision-rich parts.

**Never close or modify a parent issue** you did not create in this run.
