/**
 * Edge-case tests for the extracted project-goals Markdown parser
 * (`src/project-goals.ts`, issue #1488).
 *
 * Before #1488 these cases were exercised only indirectly through the
 * file-reading `loadProjectGoals` path. With the parser lifted into its own
 * pure `parseProjectGoals` Seam (mirroring `parseOutcomesYaml` /
 * `test/outcomes-yaml.test.mts`), the parse rules — frontmatter, section
 * splitting, metric tables, focus weights, constraints, pain points, and custom
 * sections — get a direct test surface here.
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { parseProjectGoals, type ProjectGoalsDoc } from "../src/project-goals.ts";

// ---------------------------------------------------------------------------
// frontmatter (name)
// ---------------------------------------------------------------------------

describe("parseProjectGoals — frontmatter", () => {
  test("extracts the name from YAML frontmatter", () => {
    const g = parseProjectGoals("---\nname: Betting Edge\n---\n");
    assert.equal(g.name, "Betting Edge");
  });

  test("preserves a colon inside the name value", () => {
    const g = parseProjectGoals("---\nname: Hydra: the builder\n---\n");
    assert.equal(g.name, "Hydra: the builder");
  });

  test("missing frontmatter leaves name empty (no throw)", () => {
    const g = parseProjectGoals("## Constraints\n- be safe\n");
    assert.equal(g.name, "");
    assert.deepEqual(g.constraints, ["be safe"]);
  });

  test("always echoes the raw input back on the document", () => {
    const raw = "---\nname: X\n---\n## Constraints\n- a\n";
    const g = parseProjectGoals(raw);
    assert.equal(g.raw, raw);
  });

  test("empty input parses to an empty document (no throw)", () => {
    const g = parseProjectGoals("");
    assert.equal(g.name, "");
    assert.deepEqual(g.metrics, []);
    assert.deepEqual(g.weights, {});
    assert.deepEqual(g.constraints, []);
    assert.deepEqual(g.painPoints, []);
    assert.deepEqual(g.customSections, {});
  });
});

// ---------------------------------------------------------------------------
// success metrics table
// ---------------------------------------------------------------------------

describe("parseProjectGoals — success metrics table", () => {
  test("parses a well-formed metrics table by header column names", () => {
    const raw = `## Success Metrics
| Metric | Target | Category | Source |
| --- | --- | --- | --- |
| CLV | 0.05 | profit | book |
| ROI | 10% | profit | ledger |
`;
    const g = parseProjectGoals(raw);
    assert.equal(g.metrics.length, 2);
    assert.deepEqual(g.metrics[0], {
      metric: "CLV",
      target: "0.05",
      category: "profit",
      source: "book",
    });
    assert.equal(g.metrics[1].metric, "ROI");
    assert.equal(g.metrics[1].source, "ledger");
  });

  test("drops the separator row and rows with fewer than two columns", () => {
    const raw = `## Success Metrics
| Metric | Target |
| --- | --- |
| OnlyOne |
| CLV | 0.05 |
`;
    const g = parseProjectGoals(raw);
    // The single-column "OnlyOne" row is skipped (needs >= 2 cols).
    assert.equal(g.metrics.length, 1);
    assert.equal(g.metrics[0].metric, "CLV");
    assert.equal(g.metrics[0].target, "0.05");
  });

  test("a header-only table yields no metrics (malformed: no data rows)", () => {
    const raw = `## Success Metrics
| Metric | Target |
| --- | --- |
`;
    const g = parseProjectGoals(raw);
    assert.deepEqual(g.metrics, []);
  });

  test("a section with no pipe rows yields no metrics (malformed table)", () => {
    const raw = `## Success Metrics
this is prose, not a table
`;
    const g = parseProjectGoals(raw);
    assert.deepEqual(g.metrics, []);
  });

  test("fills missing trailing cells with empty strings", () => {
    const raw = `## Success Metrics
| Metric | Target | Category | Source |
| --- | --- | --- | --- |
| CLV | 0.05 |
`;
    const g = parseProjectGoals(raw);
    assert.equal(g.metrics.length, 1);
    assert.equal(g.metrics[0].metric, "CLV");
    assert.equal(g.metrics[0].target, "0.05");
    assert.equal(g.metrics[0].category, "");
    assert.equal(g.metrics[0].source, "");
  });
});

// ---------------------------------------------------------------------------
// focus weights
// ---------------------------------------------------------------------------

describe("parseProjectGoals — focus weights", () => {
  test("parses bullet weights and slugifies multi-word categories", () => {
    const raw = `## Focus Weights
- profit: 60
- code health: 40
`;
    const g = parseProjectGoals(raw);
    const weights = g.weights as Record<string, number>;
    assert.equal(weights.profit, 60);
    assert.equal(weights.code_health, 40);
  });

  test("coerces weight values to numbers", () => {
    const g = parseProjectGoals("## Focus Weights\n- speed: 25\n");
    const weights = g.weights as Record<string, number>;
    assert.equal(typeof weights.speed, "number");
    assert.equal(weights.speed, 25);
  });

  test("ignores bullet lines that carry no numeric weight", () => {
    const g = parseProjectGoals("## Focus Weights\n- profit: high\n");
    assert.deepEqual(g.weights, {});
  });
});

// ---------------------------------------------------------------------------
// constraints + pain points
// ---------------------------------------------------------------------------

describe("parseProjectGoals — constraints and pain points", () => {
  test("collects constraint bullets", () => {
    const raw = `## Constraints
- never use cloud LLMs
* local only
`;
    const g = parseProjectGoals(raw);
    assert.deepEqual(g.constraints, ["never use cloud LLMs", "local only"]);
  });

  test("matches a pain-points heading by substring (e.g. 'Pain Points')", () => {
    const raw = `## Known Pain Points
- slow deploys
`;
    const g = parseProjectGoals(raw);
    assert.deepEqual(g.painPoints, ["slow deploys"]);
  });

  test("an empty pain-points section yields an empty list (no throw)", () => {
    const raw = `## Pain Points
`;
    const g = parseProjectGoals(raw);
    assert.deepEqual(g.painPoints, []);
  });

  test("absent pain-points section yields an empty list", () => {
    const g = parseProjectGoals("## Constraints\n- x\n");
    assert.deepEqual(g.painPoints, []);
  });
});

// ---------------------------------------------------------------------------
// unknown / custom sections + multi-section document
// ---------------------------------------------------------------------------

describe("parseProjectGoals — custom sections and full document", () => {
  test("captures unknown sections verbatim under customSections", () => {
    const raw = `## Domain Notes
some background
more lines
`;
    const g = parseProjectGoals(raw);
    assert.equal(g.customSections["domain notes"], "some background\nmore lines");
  });

  test("does not treat a pain-points section as a custom section", () => {
    const raw = `## Pain Points
- a pain
`;
    const g = parseProjectGoals(raw);
    assert.equal(g.customSections["pain points"], undefined);
    assert.deepEqual(g.painPoints, ["a pain"]);
  });

  test("parses a full multi-section document end to end", () => {
    const raw = `---
name: Demo Project
---

## Success Metrics
| Metric | Target | Category | Source |
| --- | --- | --- | --- |
| CLV | 0.05 | profit | book |

## Focus Weights
- profit: 70
- code health: 30

## Constraints
- local LLM only

## Pain Points
- flaky CI

## Extra Context
free-form notes here
`;
    const g = parseProjectGoals(raw);
    const weights = g.weights as Record<string, number>;
    assert.equal(g.name, "Demo Project");
    assert.equal(g.metrics.length, 1);
    assert.equal(g.metrics[0].metric, "CLV");
    assert.equal(weights.profit, 70);
    assert.equal(weights.code_health, 30);
    assert.deepEqual(g.constraints, ["local LLM only"]);
    assert.deepEqual(g.painPoints, ["flaky CI"]);
    assert.equal(g.customSections["extra context"], "free-form notes here");
    // Known sections must NOT leak into customSections.
    assert.equal(g.customSections["success metrics"], undefined);
    assert.equal(g.customSections["focus weights"], undefined);
    assert.equal(g.customSections["constraints"], undefined);
  });
});

// ---------------------------------------------------------------------------
// typed return shape (issue #1874 — ProjectGoalsDoc interface)
// ---------------------------------------------------------------------------

describe("parseProjectGoals — typed ProjectGoalsDoc return shape", () => {
  test("return value conforms to ProjectGoalsDoc and exposes every declared field", () => {
    const raw = `---
name: Typed Project
---

## Success Metrics
| Metric | Target | Category | Source |
| --- | --- | --- | --- |
| CLV | 0.05 | profit | book |

## Focus Weights
- profit: 80
- code health: 20

## Constraints
- local LLM only

## Pain Points
- flaky CI

## Domain Notes
free-form context
`;
    // Binding to the declared interface is the load-bearing assertion: if any
    // field in parseProjectGoals were renamed, this annotation would fail at
    // `npm run typecheck:test` rather than silently asserting against undefined.
    const g: ProjectGoalsDoc = parseProjectGoals(raw);

    assert.equal(g.name, "Typed Project");
    assert.equal(g.raw, raw);

    // metrics is Array<Record<string,string>> — header-derived dynamic keys.
    assert.equal(g.metrics.length, 1);
    const firstMetric: Record<string, string> = g.metrics[0];
    assert.equal(firstMetric.metric, "CLV");
    assert.equal(firstMetric.source, "book");

    // weights is Record<string,number> — no per-test cast needed now that the
    // return type is declared.
    assert.equal(g.weights.profit, 80);
    assert.equal(g.weights.code_health, 20);
    assert.equal(typeof g.weights.profit, "number");

    // constraints / painPoints are string[].
    assert.deepEqual(g.constraints, ["local LLM only"]);
    assert.deepEqual(g.painPoints, ["flaky CI"]);

    // customSections is Record<string,string>.
    assert.equal(g.customSections["domain notes"], "free-form context");

    // userPriorities is OPTIONAL and never written by the parser → undefined.
    assert.equal(g.userPriorities, undefined);
  });

  test("empty input still satisfies ProjectGoalsDoc with concrete defaults", () => {
    const g: ProjectGoalsDoc = parseProjectGoals("");
    assert.equal(g.name, "");
    assert.equal(g.raw, "");
    assert.deepEqual(g.metrics, []);
    assert.deepEqual(g.weights, {});
    assert.deepEqual(g.constraints, []);
    assert.deepEqual(g.painPoints, []);
    assert.deepEqual(g.customSections, {});
    assert.equal(g.userPriorities, undefined);
  });
});
