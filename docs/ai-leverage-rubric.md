---
version: 1
rubric_for: hydra-tool-scout
last_revised: 2026-05-18
---

# AI-Leverage Rubric (v1)

> **Status:** Phase A starter. The rubric is consumed by `/hydra-tool-scout` (see `docs/operator-playbooks/hydra-tool-scout.md`). Every tool the scout proposes must score **≥ 4 of 5** on the criteria below to clear Gate 1 of the filter pipeline.

The rubric measures the same five criteria for every tool, regardless of category. The category determines what "good" looks like for each criterion (a typed-schema tool earns its "structured signal" score very differently from an LSP tool). The rubric also pins a **version** in this file's frontmatter — every seen-list entry records the rubric version it was scored against, so historical scores stay legible after the rubric is revised.

## The five criteria

For each criterion, give a score 1–5 against the level descriptors below and one sentence of reasoning. The **overall score** is the median of the five (NOT the average — one weak axis shouldn't sink an otherwise excellent tool, and one excellent axis shouldn't carry a weak one).

### 1. Structured signal

How much of the tool's output is machine-readable, stable, and queryable by an agent without LLM parsing?

| Score | Descriptor |
|---|---|
| 1 | Output is free-form text only. Agent must regex stderr. |
| 2 | Output has some structure (e.g. tabular CLI) but no stable schema. |
| 3 | Output has a documented schema (JSON / NDJSON) but it changes between minor versions. |
| 4 | Stable schema, documented, with version pinning. Agents can rely on field names across upgrades. |
| 5 | Schema is the contract — the tool fails its own tests if the schema drifts. Field-level semver. |

### 2. Reduces blast radius of agent edits

When an agent uses or extends the tool, how confined is the resulting change?

| Score | Descriptor |
|---|---|
| 1 | Touching the tool ripples through unrelated parts of the codebase (global state, monkey-patches). |
| 2 | Changes are contained to one module but require coordinated updates across consumers. |
| 3 | One-file changes are common; cross-file changes are rare and well-bounded. |
| 4 | Changes are localized to the tool's own surface area; the tier classifier would put them in Tier 2 or below. |
| 5 | The tool *enforces* localization (e.g. capability injection, branded types, file-scoped modules). |

### 3. Determinism / reproducibility

How much does running the tool produce the same answer on the same inputs?

| Score | Descriptor |
|---|---|
| 1 | Output depends on network, system clock, or local config files outside the repo. |
| 2 | Output is mostly deterministic but a few attributes (timestamps, run IDs) drift. |
| 3 | Output is deterministic when invoked with `--deterministic` / equivalent flag, but the default is not. |
| 4 | Output is deterministic by default; non-determinism is opt-in and documented. |
| 5 | Tool refuses to run in non-deterministic mode (e.g. requires a lockfile, fails if env drifts). |

### 4. Discoverability for agents

Can an agent find and learn the tool from the repo alone, without operator hand-holding?

| Score | Descriptor |
|---|---|
| 1 | Knowledge of the tool is tribal. Operator must brief the agent before it can use it. |
| 2 | Tool is mentioned in a README somewhere but examples are stale. |
| 3 | Tool has a CLI `--help` that surfaces the common flows. |
| 4 | Tool is documented in this repo (CLAUDE.md, ADR, playbook) and the docs match the install. |
| 5 | Tool advertises itself via standard mechanisms (LSP server discovery, `package.json` scripts, `npm bin`) so agents find it without docs. |

### 5. Cost-to-introduce vs. ongoing leverage

How much one-time pain to integrate, vs. how much ongoing throughput it unlocks?

| Score | Descriptor |
|---|---|
| 1 | Migration cost > 1 quarter; leverage marginal. |
| 2 | Migration cost weeks; leverage modest. |
| 3 | Migration cost days; leverage moderate (steady throughput improvement). |
| 4 | Migration cost hours; leverage compounds across every cycle thereafter. |
| 5 | Drop-in (add to package.json + one CI step); leverage immediate and durable. |

## Filtering rule

A tool clears **Gate 1** of the scout pipeline iff:

- **Median across the five criteria ≥ 4**, AND
- **No criterion scores 1.**

The "no 1s" rule kills tools that are excellent in four dimensions but fail catastrophically in the fifth (e.g. a perfect schema tool that's only available as a Cloud SaaS — scores 5 on signal, 1 on determinism, median 4 — gets rejected because a single 1 is a structural defect, not a rough edge).

A tool that scores median 3 is a candidate for the operator to keep an eye on but not file. The seen-list records the score so the same tool doesn't get re-scored from scratch on the next walk.

## Worked examples

These are reference scorings the operator can sanity-check against. They are deliberately spread across categories.

### Example A — Zod (category: `typed-schemas`)

| Criterion | Score | Reasoning |
|---|---|---|
| Structured signal | 5 | Zod's parse output is a tagged union; agents pattern-match on `success: false` + `error.issues[]` without LLM parsing. |
| Reduces blast radius | 5 | Schemas are file-local; changing one schema only ripples to its consumers via TS types, caught at compile time. |
| Determinism | 5 | Pure functions over pure data. No I/O. |
| Discoverability | 4 | Well-known; widely-documented; the repo would gain a `src/schemas/` convention that agents would learn from. |
| Cost-to-introduce vs. leverage | 4 | Drop-in for new boundaries; migration of existing boundaries is a multi-cycle effort but each migration is one-PR-sized. |

**Median: 5. Verdict: PASS (Gate 1).**

### Example B — `eslint --output-format=json` (category: `lsp-language-tooling`)

| Criterion | Score | Reasoning |
|---|---|---|
| Structured signal | 5 | JSON output is stable across ESLint versions; rule IDs are versioned. |
| Reduces blast radius | 4 | Auto-fix is per-file; rule additions are config changes, not code changes. |
| Determinism | 4 | Deterministic given the same config + node version; plugin updates can drift but are caught by the lockfile. |
| Discoverability | 5 | `package.json` script + `--help`; agents already know ESLint. |
| Cost-to-introduce vs. leverage | 5 | Already in most JS/TS repos; in ours it would be additive (we use `tsc` only today). |

**Median: 5. Verdict: PASS.**

### Example C — `chalk` (category: NONE — used as a non-fit example)

| Criterion | Score | Reasoning |
|---|---|---|
| Structured signal | 1 | Output is ANSI-coded strings; agents must strip codes to parse. |
| Reduces blast radius | 3 | Function-scoped use; no structural risk. |
| Determinism | 5 | Pure. |
| Discoverability | 4 | Ubiquitous npm package. |
| Cost-to-introduce vs. leverage | 4 | Cheap. |

**Median: 4 — but a 1 on "Structured signal" trips the "no 1s" rule. Verdict: REJECT (Gate 1). Reasoning: chalk solves a human-readability problem, not an agent-leverage one. The scout should NOT file an issue.**

### Example D — `inspect_ai` (category: `eval-harnesses`)

| Criterion | Score | Reasoning |
|---|---|---|
| Structured signal | 5 | Eval outputs are JSON with stable schema; sample-level pass/fail is queryable. |
| Reduces blast radius | 3 | New harness is a new top-level concept; integration touches CI, test layout, and `package.json` simultaneously. |
| Determinism | 3 | Eval calls are LLM-backed; same inputs produce different outputs unless temperature-pinned. The harness itself is deterministic; the *model under eval* is not. |
| Discoverability | 4 | Documented and named in the playbook; agents would learn it from CLAUDE.md after merge. |
| Cost-to-introduce vs. leverage | 4 | Days to integrate; leverage compounds (every prompt change becomes A/B-able). |

**Median: 4. Verdict: PASS.** Note that the "determinism" score is 3 not 5 — eval harnesses are intrinsically about non-deterministic targets, so we mark it down but don't penalize as a structural defect.

## Calibration notes

- **Median, not average.** The rubric is robust against one weak axis but rejects structural defects (a single 1). This matches operator intent.
- **Per-category criteria weights are NOT used in v1.** If a category systematically over- or under-scores, the operator should adjust the criterion descriptors here (and bump `version` in the frontmatter), not introduce weights.
- **Re-scoring on rubric bump.** When `version:` in this file changes, the seen-list entries with the old version are not auto-rescored — the next scout walk will re-score on demand if the cooldown allows.
